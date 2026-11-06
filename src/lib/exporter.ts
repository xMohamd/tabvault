/**
 * Universal Exporter for TabVault.
 * Gathers windows, tab groups and bookmarks and produces a schema 1.1 backup object.
 * Contains no UI code.
 */
import { browser as ext, type Browser } from 'wxt/browser';
import { logger } from './logger';
import { detectBrowserAsync, type BrowserInfo } from './browser-detect';
import {
  SCHEMA_VERSION,
  WINDOW_STATES,
  type WindowState,
  emptyBackup,
  normalizeColor,
  countTabs,
  countBookmarks,
  countBookmarklets,
  type Backup,
  type BackupGroup,
  type BackupTab,
  type BackupWindow,
  type BookmarkNode,
} from './schema';
import { isBookmarkletUrl, isInternalUrl, normalizeDomain, urlMatchesDomains, unwrapPlaceholderUrl } from './url-utils';
import type { ExportOptions, ExportStats } from './types';

/** data: favicons larger than this are dropped even when favicons are requested. */
const MAX_DATA_FAVICON_LENGTH = 4096;

/** Bookmark fields kept in the export. */
const BOOKMARK_FIELDS = [
  'id', 'parentId', 'title', 'url', 'folderType', 'type', 'unmodifiable', 'dateAdded', 'index',
] as const;

interface NormalizedFilters {
  excludeInternal: boolean;
  domains: string[];
  applyToBookmarks: boolean;
}

/** How bookmarks are filtered on export. */
interface BookmarkRules {
  /** Domain / internal-page filters apply to bookmarks too. */
  filter: boolean;
  /** Keep javascript: bookmarks. They ignore the other filters: they have no host. */
  includeBookmarklets: boolean;
}

/** Opera exposes workspaces on tabs; they are not part of the standard types. */
type OperaTab = Browser.tabs.Tab & { workspaceName?: string; workspaceId?: string };

type GroupInfo = { id: number; title?: string; color?: string; collapsed?: boolean };

/** Loosely typed on purpose: these APIs may be missing at runtime. */
type OptionalApis = {
  tabGroups?: { query?: (info: object) => Promise<GroupInfo[]> };
};

type ExportedBookmark = Record<string, unknown> & { children?: ExportedBookmark[] };

/** Firefox-only tab field. */
type FirefoxTab = Browser.tabs.Tab & { cookieStoreId?: string };
type ContainerInfo = { name: string; color?: string; icon?: string };
type ContainerApi = { get: (cookieStoreId: string) => Promise<ContainerInfo | undefined> };

const DEFAULT_COOKIE_STORE = 'firefox-default';
const PRIVATE_COOKIE_STORE = 'firefox-private';

export class UniversalExporter {
  private browserInfo: BrowserInfo | null;
  /** cookieStoreId -> container, filled per export run (Firefox only). */
  private containers = new Map<string, ContainerInfo>();

  constructor({ browser }: { browser?: BrowserInfo } = {}) {
    this.browserInfo = browser ?? null;
  }

  async export(options: ExportOptions): Promise<{ data: Backup; stats: ExportStats }> {
    logger.info('EXPORT_START', options);
    const info = await this.getBrowser();
    const filters = this.normalizeFilters(options.filters);

    const data = emptyBackup({
      browser: info.key,
      browserName: info.name,
      extensionVersion: this.extensionVersion(),
      groupSystem: info.features?.tabGroups ? 'tabGroups' : 'none',
      filtersApplied: {
        excludeInternal: filters.excludeInternal,
        domains: filters.domains,
        applyToBookmarks: filters.applyToBookmarks,
        includeBookmarklets: options.includeBookmarklets !== false,
      },
    });
    data.schemaVersion = SCHEMA_VERSION;

    const skipped = { count: 0 };
    if (options.includeTabs) {
      data.windows = await this.getWindows(info, options, filters, skipped);
    }
    if (options.includeBookmarks) {
      data.bookmarks = await this.getBookmarks(info, filters, options.includeBookmarklets !== false);
    }

    const stats: ExportStats = {
      windows: data.windows.length,
      tabs: countTabs(data),
      groups: data.windows.reduce((n, w) => n + w.groups.length, 0),
      bookmarks: countBookmarks(data.bookmarks),
      bookmarklets: countBookmarklets(data.bookmarks),
      skippedTabs: skipped.count,
    };
    logger.info('EXPORT_COMPLETE', stats);
    return { data, stats };
  }

  private async getBrowser(): Promise<BrowserInfo> {
    this.browserInfo ??= await detectBrowserAsync();
    return this.browserInfo;
  }

  private extensionVersion(): string {
    try {
      return ext.runtime.getManifest().version;
    } catch {
      return 'unknown';
    }
  }

  private normalizeFilters(filters: ExportOptions['filters']): NormalizedFilters {
    const domains = Array.isArray(filters?.domains)
      ? [...new Set(filters.domains.map(normalizeDomain).filter((d): d is string => !!d))]
      : [];
    return {
      excludeInternal: filters?.excludeInternal === true,
      domains,
      applyToBookmarks: filters?.applyToBookmarks === true,
    };
  }

  // ---------------------------------------------------------------- windows

  private async getWindows(
    info: BrowserInfo,
    options: ExportOptions,
    filters: NormalizedFilters,
    skipped: { count: number },
  ): Promise<BackupWindow[]> {
    // Errors here are intentionally not caught: the export cannot proceed without windows.
    const windows = await ext.windows.getAll({ populate: true, windowTypes: ['normal'] });
    const groupMap = await this.getGroupMap(info);
    const result: BackupWindow[] = [];
    const { windowId, groupId } = options.scope ?? {};

    const candidates: Browser.windows.Window[] = [];
    for (const win of windows || []) {
      if (!win || (win.type && win.type !== 'normal')) continue;
      if (win.incognito && !options.includeIncognito) continue;
      if (windowId !== undefined && win.id !== windowId) continue;
      candidates.push(win);
    }
    await this.resolveContainers(info, candidates);

    for (const win of candidates) {
      // A group scope keeps only that group's tabs; an unknown group leaves nothing, so no window.
      const scoped =
        groupId === undefined ? win : { ...win, tabs: (win.tabs || []).filter((t) => t?.groupId === groupId) };
      const windowData = this.buildWindow(scoped, groupMap, options, filters, skipped);
      if (windowData) result.push(windowData);
    }
    return result;
  }

  /**
   * Firefox: looks up the container (contextual identity) of every tab that is not in the default
   * or a private store, once per id. Failures leave the id unresolved (the tab exports without one).
   */
  private async resolveContainers(info: BrowserInfo, windows: Browser.windows.Window[]): Promise<void> {
    this.containers = new Map();
    // `contextualIdentities` and `cookieStoreId` are Firefox-only and absent from Chrome's typings.
    const api = (ext as unknown as { contextualIdentities?: ContainerApi }).contextualIdentities;
    if (info.family !== 'gecko' || !api?.get) return;
    const ids = new Set<string>();
    for (const win of windows) {
      for (const tab of win.tabs || []) {
        const id = (tab as FirefoxTab | undefined)?.cookieStoreId;
        if (id && id !== DEFAULT_COOKIE_STORE && !id.startsWith(PRIVATE_COOKIE_STORE)) ids.add(id);
      }
    }
    for (const id of ids) {
      try {
        const identity = await api.get(id);
        if (identity?.name) {
          this.containers.set(id, { name: identity.name, color: identity.color, icon: identity.icon });
        }
      } catch (e) {
        logger.warn('EXPORT_CONTAINER_FAILED', { id }, e);
      }
    }
  }

  /** groupId -> tab group */
  private async getGroupMap(info: BrowserInfo): Promise<Map<number, GroupInfo>> {
    const map = new Map<number, GroupInfo>();
    const tabGroups = (ext as unknown as OptionalApis).tabGroups;
    if (!info.features?.tabGroups || !tabGroups?.query) return map;
    try {
      const groups = await tabGroups.query({});
      for (const g of groups || []) map.set(g.id, g);
    } catch (e) {
      logger.warn('EXPORT_GROUPS_FAILED', {}, e);
    }
    return map;
  }

  /** @returns window data, or null if nothing remains after filtering */
  private buildWindow(
    win: Browser.windows.Window,
    groupMap: Map<number, GroupInfo>,
    options: ExportOptions,
    filters: NormalizedFilters,
    skipped: { count: number },
  ): BackupWindow | null {
    const windowData: BackupWindow = { focused: !!win.focused, ungroupedTabs: [], groups: [] };
    if (options.includeWindowLayout !== false) this.addLayout(windowData, win);

    const groups = new Map<string, BackupGroup>(); // key -> group data; insertion order = order of first tab
    let nextIndex = 0;

    for (const tab of win.tabs || []) {
      const tabData = this.buildTab(tab, options, filters);
      if (!tabData) {
        skipped.count++;
        continue;
      }
      tabData.index = nextIndex++;
      this.place(tabData, tab, groupMap, groups, windowData);
    }

    windowData.groups = Array.from(groups.values());
    if (windowData.ungroupedTabs.length === 0 && windowData.groups.length === 0) return null;
    return windowData;
  }

  private addLayout(windowData: BackupWindow, win: Browser.windows.Window): void {
    // 'locked-fullscreen' (ChromeOS) is not a schema state; the importer would drop it anyway.
    if (win.state && (WINDOW_STATES as readonly string[]).includes(win.state)) {
      windowData.state = win.state as WindowState;
    }
    for (const key of ['left', 'top', 'width', 'height'] as const) {
      const v = win[key];
      if (typeof v === 'number' && Number.isFinite(v)) windowData[key] = v;
    }
  }

  /**
   * Puts a tab into a native group, an Opera workspace pseudo-group, or the ungrouped list.
   * Pinned tabs are never grouped.
   */
  private place(
    tabData: BackupTab,
    tab: Browser.tabs.Tab,
    groupMap: Map<number, GroupInfo>,
    groups: Map<string, BackupGroup>,
    windowData: BackupWindow,
  ): void {
    if (tab.pinned) {
      windowData.ungroupedTabs.push(tabData);
      return;
    }

    const groupId = tab.groupId;
    const native = typeof groupId === 'number' && groupId > -1 ? groupMap.get(groupId) : undefined;
    if (native) {
      const key = `g-${groupId}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          title: native.title || '',
          color: normalizeColor(native.color),
          collapsed: !!native.collapsed,
          tabs: [],
          metadata: { originalId: native.id },
        };
        groups.set(key, group);
      }
      group.tabs.push(tabData);
      return;
    }

    const { workspaceName, workspaceId } = tab as OperaTab;
    if (workspaceName) {
      const key = `ws-${workspaceId || workspaceName}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          title: workspaceName,
          color: 'grey',
          collapsed: false,
          tabs: [],
          metadata: { type: 'workspace', originalId: workspaceId },
        };
        groups.set(key, group);
      }
      group.tabs.push(tabData);
      return;
    }

    windowData.ungroupedTabs.push(tabData);
  }

  // ------------------------------------------------------------------- tabs

  /**
   * Builds export data for a tab, or null if it is filtered out.
   * `index` is assigned by the caller after filtering.
   */
  private buildTab(tab: Browser.tabs.Tab | null | undefined, options: ExportOptions, filters: NormalizedFilters): BackupTab | null {
    if (!tab) return null;
    const rawUrl = tab.pendingUrl || tab.url;
    if (typeof rawUrl !== 'string' || rawUrl === '') return null;

    const unwrap = options.unwrapPlaceholders !== false;
    const url = unwrap ? unwrapPlaceholderUrl(rawUrl) : rawUrl;
    if (this.shouldSkipUrl(url, filters)) return null;

    const tabData: BackupTab = {
      url,
      title: typeof tab.title === 'string' ? tab.title : '',
      index: 0,
      pinned: !!tab.pinned,
    };
    if (tab.active) tabData.active = true;

    const container = this.containers.get((tab as FirefoxTab).cookieStoreId ?? '');
    if (container) tabData.container = { ...container };

    const favicon = this.favicon(tab, options);
    if (favicon) tabData.favIconUrl = favicon;

    const { workspaceName, workspaceId } = tab as OperaTab;
    const metadata: Record<string, unknown> = {};
    if (url !== rawUrl) metadata.originalUrl = rawUrl;
    if (workspaceName) metadata.workspaceName = workspaceName;
    if (workspaceId) metadata.workspaceId = workspaceId;
    if (Object.keys(metadata).length > 0) tabData.metadata = metadata;

    return tabData;
  }

  private favicon(tab: Browser.tabs.Tab, options: ExportOptions): string | undefined {
    if (!options.includeFavicons) return undefined;
    const icon = tab.favIconUrl;
    if (typeof icon !== 'string' || icon === '') return undefined;
    if (icon.startsWith('data:') && icon.length > MAX_DATA_FAVICON_LENGTH) return undefined;
    return icon;
  }

  /** @param url effective (possibly unwrapped) URL; true if it must not be exported */
  private shouldSkipUrl(url: string, filters: NormalizedFilters): boolean {
    if (typeof url !== 'string' || url === '') return true;
    if (filters.excludeInternal && isInternalUrl(url)) return true;
    if (filters.domains.length > 0 && !urlMatchesDomains(url, filters.domains)) return true;
    return false;
  }

  // -------------------------------------------------------------- bookmarks

  private async getBookmarks(
    info: BrowserInfo,
    filters: NormalizedFilters,
    includeBookmarklets: boolean,
  ): Promise<BookmarkNode[]> {
    if (!info.features?.bookmarks) {
      logger.warn('EXPORT_BOOKMARKS_UNSUPPORTED', { browser: info.key });
      return [];
    }
    try {
      const tree = await ext.bookmarks.getTree();
      const rules: BookmarkRules = {
        filter: filters.applyToBookmarks && (filters.domains.length > 0 || filters.excludeInternal),
        includeBookmarklets,
      };
      const nodes: BookmarkNode[] = [];
      for (const root of tree || []) {
        const node = this.cleanBookmark(root, filters, rules, 0);
        if (node) nodes.push(node);
      }
      return nodes;
    } catch (e) {
      logger.error('EXPORT_BOOKMARKS_FAILED', {}, e);
      return [];
    }
  }

  /**
   * Strips volatile fields and removes bookmarks the rules exclude.
   * Folders at depth <= 1 (root and top-level role folders) are always kept.
   * Other folders are dropped when filtering empties them; with domain/internal
   * filters on, folders that were already empty are dropped too (old behaviour).
   */
  private cleanBookmark(
    node: Browser.bookmarks.BookmarkTreeNode | null | undefined,
    filters: NormalizedFilters,
    rules: BookmarkRules,
    depth: number,
  ): BookmarkNode | null {
    if (!node || typeof node !== 'object') return null;

    if (node.url) {
      if (isBookmarkletUrl(node.url)) return rules.includeBookmarklets ? this.pickBookmarkFields(node) : null;
      if (rules.filter && !this.bookmarkMatches(node.url, filters)) return null;
      return this.pickBookmarkFields(node);
    }

    const out = this.pickBookmarkFields(node);
    if (Array.isArray(node.children)) {
      out.children = node.children
        .map((child) => this.cleanBookmark(child, filters, rules, depth + 1))
        .filter((c): c is BookmarkNode => c !== null);
    } else if ((node as { children?: unknown }).children !== undefined) {
      out.children = [];
    }
    const isEmpty = !out.children || out.children.length === 0;
    const hadChildren = Array.isArray(node.children) && node.children.length > 0;
    if (depth > 1 && isEmpty && (rules.filter || (hadChildren && !rules.includeBookmarklets))) return null;
    return out;
  }

  private bookmarkMatches(url: string, filters: NormalizedFilters): boolean {
    if (filters.excludeInternal && isInternalUrl(url)) return false;
    if (filters.domains.length > 0 && !urlMatchesDomains(url, filters.domains)) return false;
    return true;
  }

  private pickBookmarkFields(node: Browser.bookmarks.BookmarkTreeNode): BookmarkNode {
    const source = node as unknown as Record<string, unknown>;
    const out: ExportedBookmark = {};
    for (const key of BOOKMARK_FIELDS) {
      if (source[key] !== undefined) out[key] = source[key];
    }
    return out as unknown as BookmarkNode;
  }
}
