/**
 * Tab Adapter: restores backed-up windows, tabs and tab groups.
 *
 * One implementation for every browser; differences are driven by the
 * capability flags from browser-detect (tabGroups, groupColors,
 * groupCollapse, discardOnCreate, ...).
 *
 * Tabs are created strictly sequentially and with an explicit `index`, so the
 * restored order matches the backup exactly.
 */
import { browser, type Browser } from 'wxt/browser';
import type { BrowserInfo } from '../browser-detect';
import { logger } from '../logger';
import {
  normalizeColor,
  orderedWindowTabs,
  type BackupGroup,
  type BackupTab,
  type BackupWindow,
  type OrderedEntry,
} from '../schema';
import type { Failure, RestoreMode } from '../types';
import { checkRestorable, dedupKey, isBlankUrl, type BrowserFamily } from '../url-utils';

/** User-visible progress messages (kept together so they can be localized later). */
export const MESSAGES = {
  window: (current: number, total: number) => `Restoring window ${current} of ${total}…`,
  group: (title: string) => `Grouping tabs: ${title || 'Untitled group'}`,
  finishing: 'Finishing up…',
};

/** The lazy placeholder page: a WXT unlisted page (entrypoint `lazy`). */
export const LAZY_PAGE_PATH = '/lazy.html' as const;

const RESTORE_MODES: ReadonlySet<string> = new Set<RestoreMode>(['discard', 'lazy', 'load']);
const DEFAULT_MODE: RestoreMode = 'discard';
const LAZY_URL_PATTERN = /^(https?|ftp|file):/i;
const COMMIT_TIMEOUT_MS = 3000;
const MAX_PENDING_DISCARDS = 5;
const MAXIMIZED_STATES: ReadonlySet<string> = new Set(['maximized', 'fullscreen']);

export interface TabImportOptions {
  restoreMode?: RestoreMode;
  restoreWindowLayout?: boolean;
  skipOpenTabs?: boolean;
  skipBlankTabs?: boolean;
  focusRestored?: boolean;
  /** 'current-window': append everything to the last-focused normal window. Default 'new-windows'. */
  target?: 'new-windows' | 'current-window';
  /** Add tabs to an existing same-titled group in the target window instead of creating one. */
  mergeGroups?: boolean;
  /** Firefox: reopen tabs in their containers. Default true. */
  restoreContainers?: boolean;
  isCancelled?: () => boolean;
  onProgress?: (done: number, message: string) => void;
  onFailure?: (failure: Failure) => void;
}

export interface TabImportStats {
  tabs: number;
  /** Groups created plus groups merged into (see groupsMerged). */
  groups: number;
  /** Of `groups`, how many were existing groups that tabs were added to. */
  groupsMerged: number;
  /** Windows created; always 0 for the 'current-window' target. */
  windows: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
}

/** Firefox-only create properties are missing from Chrome's typings. */
type CreateProps = Browser.tabs.CreateProperties & { discarded?: boolean; title?: string; cookieStoreId?: string };

/** Firefox's contextualIdentities API (absent from Chrome's typings). */
interface ContainerIdentity {
  cookieStoreId: string;
  name: string;
}
interface ContainerApi {
  query: (details: { name?: string }) => Promise<ContainerIdentity[]>;
  create: (details: { name: string; color: string; icon: string }) => Promise<ContainerIdentity>;
}

const CONTAINER_COLORS: ReadonlySet<string> = new Set([
  'blue', 'turquoise', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'toolbar',
]);
const CONTAINER_ICONS: ReadonlySet<string> = new Set([
  'fingerprint', 'briefcase', 'dollar', 'cart', 'circle', 'gift', 'vacation', 'food', 'fruit', 'pet', 'tree',
  'chill', 'fence',
]);
export const CONTAINER_UNAVAILABLE = 'container-unavailable';

interface PlanEntry extends OrderedEntry {
  ref: { id: number } | null;
}

interface WindowPlan {
  win: BackupWindow | null;
  entries: PlanEntry[];
  focused: boolean;
  isGroupWindow?: boolean;
  activeEntry?: PlanEntry;
}

interface Context {
  opts: TabImportOptions;
  mode: RestoreMode;
  stats: TabImportStats;
  done: number;
  /** Set for the 'current-window' target: the window every plan is restored into. */
  currentWindowId?: number;
  /** Container name -> cookieStoreId (undefined = could not be resolved); null when unsupported/disabled. */
  containers: { api: ContainerApi; cache: Map<string, Promise<string | undefined>> } | null;
}

type WindowLayout = Partial<Pick<Browser.windows.CreateData, 'state' | 'width' | 'height' | 'left' | 'top'>>;

const errorMessage = (e: unknown): string | undefined => (e instanceof Error ? e.message : undefined);


/** Resolves once the tab has a committed URL, or after COMMIT_TIMEOUT_MS. */
function waitForCommittedUrl(tab: Browser.tabs.Tab): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (tabId: number, changeInfo: Browser.tabs.OnUpdatedInfo, updated: Browser.tabs.Tab) => {
      if (tabId !== tab.id) return;
      if (changeInfo?.url || updated?.url || changeInfo?.status === 'complete') finish();
    };
    browser.tabs.onUpdated.addListener(listener);
    timer = setTimeout(finish, COMMIT_TIMEOUT_MS);

    if (tab.url) {
      finish();
      return;
    }
    if (tab.id === undefined) return;
    // The commit may have happened before the listener was attached.
    Promise.resolve(browser.tabs.get(tab.id))
      .then((current) => {
        if (current?.url) finish();
      })
      .catch(() => {});
  });
}

export class TabAdapter {
  readonly browser: BrowserInfo;
  private readonly family: BrowserFamily;
  private readonly features: Partial<BrowserInfo['features']>;

  /** @param browserInfo from detectBrowserAsync() */
  constructor(browserInfo: BrowserInfo) {
    this.browser = browserInfo;
    this.family = browserInfo?.family ?? 'unknown';
    this.features = browserInfo?.features ?? {};
  }

  /** Restores windows, tabs and groups. */
  async importWindows(windows: BackupWindow[], opts: TabImportOptions = {}): Promise<TabImportStats> {
    const ctx = this.createContext(opts);
    logger.info('IMPORT_WINDOWS_START', { windowCount: windows.length, mode: ctx.mode });

    if (ctx.opts.target === 'current-window') ctx.currentWindowId = await this.findCurrentWindow();

    const seen = ctx.opts.skipOpenTabs ? await this.collectOpenUrlKeys() : new Set<string>();
    const plans = this.planWindows(windows, ctx, seen);
    ctx.done = ctx.stats.skipped + ctx.stats.failed;
    if (plans.length > 0) ctx.opts.onProgress?.(ctx.done, MESSAGES.window(1, plans.length));

    let focusId: number | null = null;
    for (const [i, plan] of plans.entries()) {
      if (ctx.opts.isCancelled?.()) {
        ctx.stats.cancelled = true;
        break;
      }
      const windowId = await this.restoreWindow(plan, i, plans.length, ctx);
      if (windowId !== null && plan.focused && focusId === null) focusId = windowId;
    }

    if (ctx.opts.focusRestored && focusId !== null) {
      const id = focusId;
      await browser.windows.update(id, { focused: true }).catch((e: unknown) => {
        logger.warn('WINDOW_FOCUS_FAIL', { windowId: id }, e);
      });
    }

    logger.info('IMPORT_WINDOWS_COMPLETE', ctx.stats);
    return { ...ctx.stats };
  }

  // ---- setup ----------------------------------------------------------

  /** The last-focused normal window, or undefined (callers then fall back to new windows). */
  private async findCurrentWindow(): Promise<number | undefined> {
    try {
      const win = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
      if (win?.id !== undefined && (!win.type || win.type === 'normal')) return win.id;
    } catch (e) {
      logger.warn('CURRENT_WINDOW_LOOKUP_FAIL', {}, e);
    }
    return undefined;
  }

  private containerApi(opts: TabImportOptions): ContainerApi | null {
    if (opts.restoreContainers === false || this.family !== 'gecko') return null;
    // Firefox-only API, absent from Chrome's typings.
    const api = (browser as unknown as { contextualIdentities?: ContainerApi }).contextualIdentities;
    return typeof api?.query === 'function' && typeof api.create === 'function' ? api : null;
  }

  private createContext(opts: TabImportOptions): Context {
    const api = this.containerApi(opts);
    return {
      containers: api ? { api, cache: new Map() } : null,
      opts: {
        restoreWindowLayout: true,
        skipOpenTabs: false,
        skipBlankTabs: true,
        focusRestored: false,
        ...opts,
      },
      mode: opts.restoreMode && RESTORE_MODES.has(opts.restoreMode) ? opts.restoreMode : DEFAULT_MODE,
      stats: { tabs: 0, groups: 0, groupsMerged: 0, windows: 0, skipped: 0, failed: 0, cancelled: false },
      done: 0,
    };
  }

  private async collectOpenUrlKeys(): Promise<Set<string>> {
    const keys = new Set<string>();
    try {
      const tabs = await browser.tabs.query({});
      for (const t of tabs) {
        const url = t.url || t.pendingUrl;
        if (url) keys.add(dedupKey(url));
      }
    } catch (e) {
      logger.warn('QUERY_OPEN_TABS_FAIL', {}, e);
    }
    return keys;
  }

  /**
   * Builds the list of windows to create, with filtered and ordered tabs.
   * Without tab group support each group becomes its own window.
   */
  private planWindows(windows: BackupWindow[], ctx: Context, seen: Set<string>): WindowPlan[] {
    const plans: WindowPlan[] = [];
    const add = (win: BackupWindow | null, entries: OrderedEntry[], focused: boolean, isGroupWindow?: boolean) => {
      const kept = this.filterEntries(entries, ctx, seen);
      if (kept.length > 0) plans.push({ win, entries: kept, focused, ...(isGroupWindow ? { isGroupWindow } : {}) });
    };

    for (const win of windows) {
      if (this.features.tabGroups) {
        add(win, orderedWindowTabs(win), win.focused === true);
        continue;
      }
      add(win, orderedWindowTabs({ ungroupedTabs: win.ungroupedTabs, groups: [] }), win.focused === true);
      for (const group of win.groups ?? []) {
        add(null, orderedWindowTabs({ ungroupedTabs: group.tabs, groups: [] }), false, true);
      }
    }
    return plans;
  }

  /** Drops unrestorable, blank and duplicate tabs, reporting each. */
  private filterEntries(entries: OrderedEntry[], ctx: Context, seen: Set<string>): PlanEntry[] {
    const kept: PlanEntry[] = [];
    for (const entry of entries) {
      const { url, title } = entry.tab;
      const check = checkRestorable(url, this.family);
      if (!check.ok) {
        ctx.stats.failed++;
        ctx.opts.onFailure?.({ kind: 'tab', url, title, reason: check.reason });
        continue;
      }
      const key = dedupKey(url);
      if ((ctx.opts.skipBlankTabs && isBlankUrl(url)) || seen.has(key)) {
        ctx.stats.skipped++;
        continue;
      }
      // Always track, so duplicates inside the backup are skipped too.
      seen.add(key);
      kept.push({ ...entry, ref: null });
    }
    return kept;
  }

  // ---- window restore -------------------------------------------------

  /** @returns id of the created window, or null */
  private async restoreWindow(plan: WindowPlan, index: number, total: number, ctx: Context): Promise<number | null> {
    const message = MESSAGES.window(index + 1, total);
    if (ctx.currentWindowId !== undefined) return this.restoreIntoCurrentWindow(plan, ctx.currentWindowId, ctx, message);
    const created = await this.createWindow(plan, ctx);
    if (!created) {
      this.failWindowTabs(plan, ctx, message);
      return null;
    }

    const { windowId, defaultTabId } = created;
    let tabCount = 0;
    try {
      tabCount = await this.createTabs(plan, windowId, ctx, message);
      await this.finishWindow(plan, windowId, ctx);
    } finally {
      await this.cleanupWindow(windowId, defaultTabId, tabCount);
    }

    if (tabCount === 0) return null;
    ctx.stats.windows++;
    if (plan.isGroupWindow) ctx.stats.groups++;
    return windowId;
  }

  /**
   * Appends the plan's tabs to an existing window. Creates no window, leaves no default tab to
   * clean up and never changes the active tab or window focus.
   * @returns always null: no window was created or needs focusing
   */
  private async restoreIntoCurrentWindow(
    plan: WindowPlan,
    windowId: number,
    ctx: Context,
    message: string,
  ): Promise<null> {
    const baseIndex = await this.countWindowTabs(windowId);
    await this.createTabs(plan, windowId, ctx, message, baseIndex);
    await this.finishWindow(plan, windowId, ctx);
    return null;
  }

  private async countWindowTabs(windowId: number): Promise<number | undefined> {
    try {
      return (await browser.tabs.query({ windowId })).length;
    } catch (e) {
      logger.warn('COUNT_WINDOW_TABS_FAIL', { windowId }, e);
      return undefined; // no explicit index: the browser appends
    }
  }

  private failWindowTabs(plan: WindowPlan, ctx: Context, message: string): void {
    for (const { tab } of plan.entries) {
      ctx.stats.failed++;
      ctx.done++;
      ctx.opts.onFailure?.({ kind: 'tab', url: tab.url, title: tab.title, reason: 'window-create-failed' });
    }
    ctx.opts.onProgress?.(ctx.done, message);
  }

  private layoutFor(win: BackupWindow | null, ctx: Context): WindowLayout {
    if (!win || !ctx.opts.restoreWindowLayout) return {};
    if (win.state && MAXIMIZED_STATES.has(win.state)) return { state: win.state as 'maximized' | 'fullscreen' };
    const isNormal = win.state === undefined || win.state === 'normal';
    const { width, height, left, top } = win;
    if (!isNormal || !Number.isFinite(width) || !Number.isFinite(height)) return {};
    const layout: WindowLayout = { width, height };
    if (Number.isFinite(left)) layout.left = left;
    if (Number.isFinite(top)) layout.top = top;
    return layout;
  }

  private async createWindow(
    plan: WindowPlan,
    ctx: Context,
  ): Promise<{ windowId: number; defaultTabId: number | undefined } | null> {
    const layout = this.layoutFor(plan.win, ctx);
    let win: Browser.windows.Window | null | undefined = null;
    try {
      win = await browser.windows.create({ focused: false, ...layout });
    } catch (e) {
      logger.warn('WINDOW_CREATE_LAYOUT_FAIL', { layout }, e);
      try {
        win = await browser.windows.create({ focused: false });
      } catch (e2) {
        logger.error('WINDOW_CREATE_FAIL', {}, e2);
      }
    }
    if (!win || win.id === undefined) return null;
    return { windowId: win.id, defaultTabId: win.tabs?.[0]?.id };
  }

  /** Removes the window's default tab, or the whole window when nothing was restored into it. */
  private async cleanupWindow(windowId: number, defaultTabId: number | undefined, tabCount: number): Promise<void> {
    try {
      if (tabCount > 0) {
        if (defaultTabId !== undefined) await browser.tabs.remove(defaultTabId);
      } else {
        await browser.windows.remove(windowId);
      }
    } catch (e) {
      logger.warn('WINDOW_CLEANUP_FAIL', { windowId }, e);
    }
  }

  // ---- tab creation ---------------------------------------------------

  /**
   * Creates tabs one by one in order. Discard waits run concurrently in a small pool.
   * @returns number of tabs created
   */
  private async createTabs(
    plan: WindowPlan,
    windowId: number,
    ctx: Context,
    message: string,
    baseIndex: number | undefined = 0,
  ): Promise<number> {
    // Into an existing window nothing is activated: every restored tab is a background tab.
    const intoCurrent = ctx.currentWindowId !== undefined;
    const activeEntry = intoCurrent ? undefined : (plan.entries.find((e) => e.tab.active) ?? plan.entries[0]);
    const pending = new Set<Promise<void>>();
    let count = 0;

    for (const entry of plan.entries) {
      if (ctx.opts.isCancelled?.()) {
        ctx.stats.cancelled = true;
        break;
      }
      const defer = entry !== activeEntry;
      try {
        const index = baseIndex === undefined ? undefined : baseIndex + count;
        const tab = await this.createTab(entry.tab, windowId, index, ctx, defer);
        if (tab.id === undefined) throw new Error('create-failed');
        entry.ref = { id: tab.id };
        count++;
        ctx.stats.tabs++;
        if (this.needsDiscard(entry.tab, ctx.mode, defer)) {
          await this.queueDiscard(pending, tab, entry.ref);
        }
      } catch (e) {
        logger.warn('TAB_CREATE_FAIL', { url: entry.tab.url }, e);
        ctx.stats.failed++;
        ctx.opts.onFailure?.({
          kind: 'tab',
          url: entry.tab.url,
          title: entry.tab.title,
          reason: errorMessage(e) || 'create-failed',
        });
      }
      ctx.done++;
      ctx.opts.onProgress?.(ctx.done, message);
    }

    await Promise.all(pending);
    if (activeEntry) plan.activeEntry = activeEntry;
    return count;
  }

  private isLazyUrl(url: string): boolean {
    return LAZY_URL_PATTERN.test(url);
  }

  /** Chromium needs a post-create discard; Firefox discards at creation; lazy/load never do. */
  private needsDiscard(tab: BackupTab, mode: RestoreMode, defer: boolean): boolean {
    if (mode === 'load' || !defer || this.features.discardOnCreate) return false;
    if (mode === 'lazy' && this.isLazyUrl(tab.url)) return false;
    return !!this.features.discard;
  }

  private async createTab(
    tab: BackupTab,
    windowId: number,
    index: number | undefined,
    ctx: Context,
    defer: boolean,
  ): Promise<Browser.tabs.Tab> {
    const mode = ctx.mode;
    const props: CreateProps = { windowId, url: tab.url, active: false, pinned: tab.pinned === true };
    if (index !== undefined) props.index = index;
    if (mode === 'lazy' && defer && this.isLazyUrl(tab.url)) {
      props.url = this.lazyUrl(tab);
    } else if (mode !== 'load' && defer && this.features.discardOnCreate && !props.pinned) {
      // Firefox forbids discarded together with pinned or active.
      props.discarded = true;
      if (tab.title) props.title = tab.title;
    }
    // `discarded`, `title` and `cookieStoreId` are Firefox-only and absent from Chrome's types; the
    // browser ignores or accepts them as appropriate, so a single cast at the call is enough.
    const create = (p: CreateProps) => browser.tabs.create(p as Browser.tabs.CreateProperties);

    if (!tab.container || !ctx.containers) return create(props);
    const cookieStoreId = await this.resolveContainer(tab.container, ctx.containers);
    if (cookieStoreId === undefined) {
      this.reportContainerUnavailable(tab, ctx);
      return create(props);
    }
    try {
      return await create({ ...props, cookieStoreId });
    } catch (e) {
      // Retry without the container: the tab opening matters more than where it lives.
      logger.warn('TAB_CREATE_CONTAINER_FAIL', { url: tab.url }, e);
      this.reportContainerUnavailable(tab, ctx);
      return create(props);
    }
  }

  private reportContainerUnavailable(tab: BackupTab, ctx: Context): void {
    ctx.opts.onFailure?.({ kind: 'tab', url: tab.url, title: tab.title, reason: CONTAINER_UNAVAILABLE });
  }

  /** Name -> cookieStoreId: reuses an existing container, creates a missing one. Cached per name. */
  private resolveContainer(
    container: NonNullable<BackupTab['container']>,
    ctx: NonNullable<Context['containers']>,
  ): Promise<string | undefined> {
    let pending = ctx.cache.get(container.name);
    if (!pending) {
      pending = this.loadContainer(container, ctx.api).catch((e: unknown) => {
        logger.warn('CONTAINER_RESOLVE_FAIL', { name: container.name }, e);
        return undefined;
      });
      ctx.cache.set(container.name, pending);
    }
    return pending;
  }

  private async loadContainer(
    { name, color, icon }: NonNullable<BackupTab['container']>,
    api: ContainerApi,
  ): Promise<string | undefined> {
    const existing = (await api.query({ name })).find((i) => i.name === name);
    if (existing) return existing.cookieStoreId;
    const created = await api.create({
      name,
      color: color && CONTAINER_COLORS.has(color) ? color : 'blue',
      icon: icon && CONTAINER_ICONS.has(icon) ? icon : 'fingerprint',
    });
    return created?.cookieStoreId;
  }

  private lazyUrl(tab: BackupTab): string {
    const query = new URLSearchParams({
      url: tab.url,
      title: tab.title || '',
      favicon: tab.favIconUrl || '',
    });
    return `${browser.runtime.getURL(LAZY_PAGE_PATH)}?${query}`;
  }

  /** Starts a discard task, first making room when the pool is full. */
  private async queueDiscard(pending: Set<Promise<void>>, tab: Browser.tabs.Tab, ref: { id: number }): Promise<void> {
    while (pending.size >= MAX_PENDING_DISCARDS) await Promise.race(pending);
    const task: Promise<void> = this.discardWhenCommitted(tab, ref).finally(() => {
      pending.delete(task);
    });
    pending.add(task);
  }

  /** Waits for the URL to commit (discarding earlier loses it), then discards. */
  private async discardWhenCommitted(tab: Browser.tabs.Tab, ref: { id: number }): Promise<void> {
    try {
      await waitForCommittedUrl(tab);
      if (tab.id === undefined) return;
      const discarded = await browser.tabs.discard(tab.id);
      // Older Chromium replaces the tab (and its id) on discard.
      if (discarded?.id !== undefined) ref.id = discarded.id;
    } catch (e) {
      logger.warn('TAB_DISCARD_FAIL', { tabId: tab.id }, e);
    }
  }

  // ---- grouping & activation -----------------------------------------

  private async finishWindow(plan: WindowPlan, windowId: number, ctx: Context): Promise<void> {
    const created = plan.entries.filter((e): e is PlanEntry & { ref: { id: number } } => e.ref !== null);
    const first = created[0];
    if (!first) return;

    // In an existing window the user's active tab stays; restored tabs are all background tabs.
    const active =
      ctx.currentWindowId !== undefined ? undefined : (created.find((e) => e === plan.activeEntry) ?? first);
    if (active) {
      try {
        await browser.tabs.update(active.ref.id, { active: true });
      } catch (e) {
        logger.warn('TAB_ACTIVATE_FAIL', { tabId: active.ref.id }, e);
      }
    }
    if (!plan.isGroupWindow && this.features.tabGroups) {
      await this.groupTabs(plan, created, active, windowId, ctx);
    }
  }

  private async groupTabs(
    plan: WindowPlan,
    created: Array<PlanEntry & { ref: { id: number } }>,
    active: PlanEntry | undefined,
    windowId: number,
    ctx: Context,
  ): Promise<void> {
    const groups = plan.win?.groups ?? [];
    for (const [gi, group] of groups.entries()) {
      // Pinned tabs cannot be grouped; they stay pinned and ungrouped.
      const members = created.filter((e) => e.groupIndex === gi && !e.tab.pinned);
      if (members.length === 0) continue;
      ctx.opts.onProgress?.(ctx.done, MESSAGES.group(group.title));
      try {
        const [firstId, ...restIds] = members.map((e) => e.ref.id);
        if (firstId === undefined) continue;
        const tabIds: [number, ...number[]] = [firstId, ...restIds];
        const existingId = ctx.opts.mergeGroups ? await this.findGroupByTitle(windowId, group.title) : undefined;
        if (existingId !== undefined) {
          // Join the existing group as is: its color and collapsed state are the user's.
          await browser.tabs.group({ tabIds, groupId: existingId });
          ctx.stats.groupsMerged++;
        } else {
          const groupId = await browser.tabs.group({ tabIds, createProperties: { windowId } });
          await this.styleGroup(groupId, group, !!active && members.includes(active as (typeof members)[number]));
        }
        ctx.stats.groups++;
      } catch (e) {
        logger.warn('GROUP_CREATE_FAIL', { title: group.title }, e);
        ctx.opts.onFailure?.({ kind: 'group', title: group.title, reason: errorMessage(e) || 'group-failed' });
      }
    }
  }

  /** Id of an existing group in the window with exactly this (non-empty) title, if any. */
  private async findGroupByTitle(windowId: number, title: string): Promise<number | undefined> {
    if (!title) return undefined;
    try {
      const matches = await browser.tabGroups.query({ windowId, title });
      return matches.find((g) => g.title === title)?.id;
    } catch (e) {
      logger.warn('GROUP_QUERY_FAIL', { windowId }, e);
      return undefined;
    }
  }

  private async styleGroup(groupId: number, group: BackupGroup, holdsActiveTab: boolean): Promise<void> {
    const update: Browser.tabGroups.UpdateProperties = { title: group.title || '' };
    // A group holding the active tab cannot stay collapsed.
    if (this.features.groupCollapse) update.collapsed = group.collapsed === true && !holdsActiveTab;
    if (this.features.groupColors) update.color = normalizeColor(group.color);
    await browser.tabGroups.update(groupId, update);
  }
}
