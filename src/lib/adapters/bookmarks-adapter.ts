/**
 * Bookmarks Adapter
 * Imports exported bookmark trees (Chromium or Firefox shaped) into the local browser.
 *
 * Local "root" folders (bar, other, mobile, menu) are found by role, never by
 * localized title, so the same code works in Chrome, Edge, Brave, Vivaldi and Firefox.
 */
import { browser, type Browser } from 'wxt/browser';
import { logger } from '../logger';
import { countBookmarks, type BookmarkNode } from '../schema';
import type { BookmarkStrategy, Failure } from '../types';
import { dedupKey, type BrowserFamily } from '../url-utils';

const MAX_DEPTH = 100;
const PROGRESS_STEP = 25;

export type RootRole = 'bar' | 'other' | 'mobile' | 'menu' | 'managed';

/** Ids of the invisible tree root: Chromium '0', Firefox 'root________'. */
const ROOT_NODE_IDS: ReadonlySet<string> = new Set(['0', 'root________']);

const FOLDER_TYPE_ROLES: Record<string, RootRole> = {
  'bookmarks-bar': 'bar',
  other: 'other',
  mobile: 'mobile',
  managed: 'managed',
};
const FIREFOX_ID_ROLES: Record<string, RootRole> = {
  toolbar_____: 'bar',
  unfiled_____: 'other',
  mobile______: 'mobile',
  menu________: 'menu',
};
const CHROMIUM_ID_ROLES: Record<string, RootRole> = { '1': 'bar', '2': 'other', '3': 'mobile' };
const TITLE_ROLES: Record<string, RootRole> = {
  'bookmarks bar': 'bar',
  'bookmarks toolbar': 'bar',
  'other bookmarks': 'other',
  'mobile bookmarks': 'mobile',
  'bookmarks menu': 'menu',
};

/** Roles whose children are cleared by the 'replace' strategy. */
const REPLACEABLE_ROLES: RootRole[] = ['bar', 'other', 'mobile', 'menu'];

/** URL schemes each browser family refuses in bookmarks.create. */
const REJECTED_SCHEMES: Partial<Record<BrowserFamily, string[]>> = {
  gecko: ['javascript', 'data', 'chrome', 'chrome-extension', 'edge', 'brave', 'opera', 'vivaldi'],
  chromium: ['place', 'about', 'moz-extension'],
};

/** Looks up an own property only (ids/titles come from untrusted backups). */
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Minimal node shape shared by exported nodes and live BookmarkTreeNodes. */
type RoleNode = Partial<Pick<BookmarkNode, 'id' | 'title' | 'folderType' | 'unmodifiable' | 'url' | 'type'>> & {
  parentId?: string;
  children?: unknown[];
};

/**
 * Determines which well-known root a bookmark folder is.
 * Order: folderType (Chrome 134+), Firefox ids, Chromium legacy ids, managed flag,
 * and finally (exported data only) English titles.
 * @param options.allowTitle also match English titles (exported data only)
 */
export function rootRole(node: unknown, { allowTitle = false }: { allowTitle?: boolean } = {}): RootRole | null {
  if (!node || typeof node !== 'object') return null;
  const n = node as RoleNode;
  if (n.folderType) {
    const role = lookup(FOLDER_TYPE_ROLES, n.folderType);
    if (role) return role;
  }
  if (typeof n.id === 'string') {
    const role = lookup(FIREFOX_ID_ROLES, n.id) ?? lookup(CHROMIUM_ID_ROLES, n.id);
    if (role) return role;
  }
  if (n.unmodifiable === 'managed') return 'managed';
  if (allowTitle && typeof n.title === 'string') {
    return lookup(TITLE_ROLES, n.title.trim().toLowerCase()) ?? null;
  }
  return null;
}

/** `type` is Firefox-only: absent from Chrome's BookmarkTreeNode, hence `unknown`. */
const isSeparator = (node: unknown): boolean => (node as { type?: string } | null | undefined)?.type === 'separator';
const isManaged = (node: { unmodifiable?: string; folderType?: string } | null | undefined): boolean =>
  node?.unmodifiable === 'managed' || node?.folderType === 'managed';
const isFolder = (node: BookmarkNode | null | undefined): boolean => !node?.url && !isSeparator(node);

/**
 * An exported tree root (Chrome '0', Firefox 'root________'): no parent, has children,
 * and is either a known root id or contains role folders. Ordinary user folders
 * without a parentId are NOT treated as roots.
 */
function isTreeRoot(node: BookmarkNode | null | undefined): node is BookmarkNode & { children: BookmarkNode[] } {
  if (!node || node.parentId || node.url || !Array.isArray(node.children)) return false;
  if (node.id !== undefined && ROOT_NODE_IDS.has(node.id)) return true;
  return node.children.some((c) => isFolder(c) && rootRole(c, { allowTitle: true }) !== null);
}

/** Replaces tree roots by their children so the result is a list of top-level folders/nodes. */
function flattenRoots(nodes: BookmarkNode[] | undefined, depth = 0): BookmarkNode[] {
  const out: BookmarkNode[] = [];
  for (const node of nodes ?? []) {
    if (depth < MAX_DEPTH && isTreeRoot(node)) out.push(...flattenRoots(node.children, depth + 1));
    else if (node) out.push(node);
  }
  return out;
}

/** Why a URL cannot be created in this browser family, or null if it should be attempted. */
function unsupportedUrlReason(url: string, family: BrowserFamily): 'unsupported-url' | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(String(url).trim());
  const scheme = match?.[1];
  if (!scheme) return null;
  const rejected = REJECTED_SCHEMES[family] ?? [];
  return rejected.includes(scheme.toLowerCase()) ? 'unsupported-url' : null;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type TreeNode = Browser.bookmarks.BookmarkTreeNode;
/** Firefox-only create property (`type: 'separator'`), absent from Chrome's typings. */
type CreateArg = Browser.bookmarks.CreateDetails & { type?: 'separator' };

interface LocalRoots {
  byRole: Partial<Record<RootRole, TreeNode>>;
  modifiable: TreeNode[];
}

interface FolderState {
  keys: Set<string>;
  folders: Map<string, string>;
  fresh: boolean;
}

export interface BookmarksImportOptions {
  strategy?: BookmarkStrategy;
  /** Skip URLs already in the target folder; reuse same-title subfolders. Default true. */
  skipDuplicates?: boolean;
  isCancelled?: () => boolean;
  /** processed / total URL bookmarks */
  onProgress?: (current: number, total: number) => void;
  onFailure?: (failure: Failure) => void;
}

export interface BookmarksImportResult {
  created: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  folderId?: string;
}

/** Per-run mutable state, so one adapter instance can be reused safely. */
interface Context {
  strategy: BookmarkStrategy;
  total: number;
  family: BrowserFamily;
  skipDuplicates: boolean;
  created: number;
  skipped: number;
  failed: number;
  processed: number;
  reported: number;
  cancelled: boolean;
  /** parentId -> existing children summary */
  folderCache: Map<string, FolderState>;
  stopped(): boolean;
  fail(failure: Omit<Failure, 'kind'>): void;
  advance(count?: number): void;
  flushProgress(): void;
}

export class BookmarksAdapter {
  readonly family: BrowserFamily;

  constructor({ family = 'unknown' }: { family?: BrowserFamily } = {}) {
    this.family = family;
  }

  /**
   * Import bookmarks.
   *
   * Strategies:
   * - 'merge': children of each exported root folder go into the matching local root.
   * - 'folder': everything is recreated inside a new "Imported <date>" folder.
   * - 'replace': DESTRUCTIVE. Removes all children of the local bar/other/mobile/menu
   *   roots, then merges. The caller MUST back up first and confirm with the user.
   *
   * @param nodes exported tree (roots as from bookmarks.getTree(), or any node list)
   */
  async import(nodes: BookmarkNode[], opts: BookmarksImportOptions = {}): Promise<BookmarksImportResult> {
    const strategy = opts.strategy ?? 'merge';
    const topNodes = flattenRoots(Array.isArray(nodes) ? nodes : []);
    const ctx = this.createContext(opts, strategy, countBookmarks(topNodes));

    logger.info('BOOKMARKS_IMPORT_START', { strategy, total: ctx.total, family: this.family });

    let folderId: string | undefined;
    try {
      const local = await this.loadLocalRoots();
      if (strategy === 'replace') await this.clearLocalRoots(ctx, local);
      if (!ctx.stopped()) {
        if (strategy === 'folder') folderId = await this.importIntoFolder(ctx, topNodes, local);
        else await this.importMerge(ctx, topNodes, local);
      }
    } catch (e) {
      // Setup failures (e.g. getTree rejected): nothing more can be imported.
      logger.warn('BOOKMARKS_IMPORT_ABORTED', { strategy }, e);
      this.failRemaining(ctx, errorMessage(e));
    }

    ctx.flushProgress();
    const result: BookmarksImportResult = {
      created: ctx.created,
      skipped: ctx.skipped,
      failed: ctx.failed,
      cancelled: ctx.cancelled,
    };
    if (folderId) result.folderId = folderId;
    logger.info('BOOKMARKS_IMPORT_COMPLETE', { strategy, ...result });
    return result;
  }

  // ---------------------------------------------------------------- context

  private createContext(opts: BookmarksImportOptions, strategy: BookmarkStrategy, total: number): Context {
    const ctx: Context = {
      strategy,
      total,
      family: this.family,
      skipDuplicates: opts.skipDuplicates !== false,
      created: 0,
      skipped: 0,
      failed: 0,
      processed: 0,
      reported: -1,
      cancelled: false,
      folderCache: new Map(),
      stopped() {
        if (ctx.cancelled) return true;
        try {
          if (opts.isCancelled?.()) ctx.cancelled = true;
        } catch {
          // A broken cancel callback must not break the import.
        }
        return ctx.cancelled;
      },
      fail(failure) {
        try {
          opts.onFailure?.({ kind: 'bookmark', ...failure });
        } catch {
          // Ignore reporter errors.
        }
      },
      /** Marks `count` URL bookmarks as processed and reports progress every PROGRESS_STEP. */
      advance(count = 1) {
        const before = ctx.processed;
        ctx.processed += count;
        if (Math.floor(ctx.processed / PROGRESS_STEP) > Math.floor(before / PROGRESS_STEP)) ctx.flushProgress();
      },
      flushProgress() {
        if (ctx.reported === ctx.processed) return;
        ctx.reported = ctx.processed;
        try {
          opts.onProgress?.(ctx.processed, ctx.total);
        } catch {
          // Ignore reporter errors.
        }
      },
    };
    return ctx;
  }

  // ------------------------------------------------------------ local roots

  /** Finds local root folders by role. */
  private async loadLocalRoots(): Promise<LocalRoots> {
    const [root] = await browser.bookmarks.getTree();
    const byRole: LocalRoots['byRole'] = {};
    const modifiable: TreeNode[] = [];
    for (const child of root?.children ?? []) {
      const role = rootRole(child);
      if (role === 'managed' || isManaged(child)) continue; // never write into managed roots
      modifiable.push(child);
      if (role && !byRole[role]) byRole[role] = child;
    }
    return { byRole, modifiable };
  }

  /** The folder that receives anything without a better home. */
  private fallbackRoot(local: LocalRoots): TreeNode | null {
    return local.byRole.other ?? local.modifiable[0] ?? null;
  }

  /** 'replace' step: delete everything inside the local bar/other/mobile/menu roots. */
  private async clearLocalRoots(ctx: Context, local: LocalRoots): Promise<void> {
    for (const role of REPLACEABLE_ROLES) {
      const rootNode = local.byRole[role];
      if (!rootNode) continue;
      let children: TreeNode[] = [];
      try {
        children = await browser.bookmarks.getChildren(rootNode.id);
      } catch (e) {
        logger.warn('BOOKMARKS_REPLACE_LIST_FAILED', { role }, e);
        continue;
      }
      for (const child of children) {
        if (ctx.stopped()) return;
        if (isManaged(child)) continue;
        try {
          if (child.url || isSeparator(child)) await browser.bookmarks.remove(child.id);
          else await browser.bookmarks.removeTree(child.id);
        } catch (e) {
          logger.warn('BOOKMARKS_REMOVE_FAILED', { id: child.id, title: child.title }, e);
          ctx.failed++;
          ctx.fail({ url: child.url, title: child.title ?? '', reason: `remove failed: ${errorMessage(e)}` });
        }
      }
      ctx.folderCache.delete(rootNode.id); // contents changed; refetch lazily
    }
  }

  // ------------------------------------------------------------ strategies

  /** merge (and the second half of replace). */
  private async importMerge(ctx: Context, topNodes: BookmarkNode[], local: LocalRoots): Promise<void> {
    const fallback = this.fallbackRoot(local);
    if (!fallback) {
      this.failRemaining(ctx, 'no writable bookmark root');
      return;
    }
    for (const node of topNodes) {
      if (ctx.stopped()) return;
      const role = isFolder(node) ? rootRole(node, { allowTitle: true }) : null;
      const target = role ? local.byRole[role] : undefined;
      if (role === 'managed' || isManaged(node)) {
        this.skipSubtree(ctx, node);
      } else if (target) {
        // Role folder -> its matching local root; its children are merged directly.
        await this.processList(ctx, node.children ?? [], target.id, 1);
      } else {
        // Role folder with no local match goes in as a titled subfolder under "other";
        // non-role top-level nodes land in "other" directly.
        await this.processNode(ctx, node, fallback.id, 0);
      }
    }
  }

  /** folder strategy. @returns id of the new folder */
  private async importIntoFolder(ctx: Context, topNodes: BookmarkNode[], local: LocalRoots): Promise<string | undefined> {
    const parent = this.fallbackRoot(local);
    if (!parent) {
      this.failRemaining(ctx, 'no writable bookmark root');
      return undefined;
    }
    let container: TreeNode;
    try {
      container = await browser.bookmarks.create({
        parentId: parent.id,
        title: `Imported ${new Date().toLocaleDateString()}`,
      });
    } catch (e) {
      logger.warn('BOOKMARKS_IMPORT_FOLDER_FAILED', {}, e);
      this.failRemaining(ctx, errorMessage(e));
      return undefined;
    }
    ctx.folderCache.set(container.id, { keys: new Set(), folders: new Map(), fresh: true });
    // Each exported role folder becomes a titled subfolder; managed nodes are skipped.
    await this.processList(ctx, topNodes, container.id, 0);
    return container.id;
  }

  // ----------------------------------------------------------- node walking

  private async processList(ctx: Context, nodes: BookmarkNode[], parentId: string, depth: number): Promise<void> {
    for (const node of nodes) {
      if (ctx.stopped()) return;
      await this.processNode(ctx, node, parentId, depth);
    }
  }

  private async processNode(ctx: Context, node: BookmarkNode, parentId: string, depth: number): Promise<void> {
    if (!node || typeof node !== 'object') return;
    if (isManaged(node)) {
      this.skipSubtree(ctx, node);
    } else if (isSeparator(node)) {
      await this.addSeparator(ctx, parentId);
    } else if (node.url) {
      await this.addBookmark(ctx, node, node.url, parentId);
    } else {
      await this.addFolder(ctx, node, parentId, depth);
    }
  }

  private skipSubtree(ctx: Context, node: BookmarkNode): void {
    const urls = countBookmarks([node]);
    ctx.skipped += Math.max(urls, 1);
    ctx.advance(urls);
  }

  private async addSeparator(ctx: Context, parentId: string): Promise<void> {
    // Separators have no URL to dedupe on, so skip them when merging into a folder that
    // already had content; otherwise re-running an import would stack up separators.
    const state = await this.folderState(ctx, parentId);
    if (this.family === 'gecko' && !(state && !state.fresh)) {
      try {
        // `type` is Firefox-only and missing from Chrome's typings.
        const arg: CreateArg = { parentId, type: 'separator' };
        await browser.bookmarks.create(arg as Browser.bookmarks.CreateDetails);
        ctx.created++;
        return;
      } catch (e) {
        logger.warn('BOOKMARKS_SEPARATOR_FAILED', { parentId }, e);
      }
    }
    // Not supported (or failed): purely cosmetic, so skipped rather than failed.
    ctx.skipped++;
  }

  private async addBookmark(ctx: Context, node: BookmarkNode, url: string, parentId: string): Promise<void> {
    const title = node.title ?? '';
    const reason = unsupportedUrlReason(url, ctx.family);
    if (reason) {
      this.recordFailure(ctx, { url, title, reason });
      return;
    }

    const state = await this.folderState(ctx, parentId);
    const key = dedupKey(url);
    if (state?.keys.has(key)) {
      ctx.skipped++;
      ctx.advance();
      return;
    }

    try {
      await browser.bookmarks.create({ parentId, title, url });
      ctx.created++;
      state?.keys.add(key);
      ctx.advance();
    } catch (e) {
      logger.warn('BOOKMARK_CREATE_FAILED', { url, title }, e);
      this.recordFailure(ctx, { url, title, reason: errorMessage(e) });
    }
  }

  private async addFolder(ctx: Context, node: BookmarkNode, parentId: string, depth: number): Promise<void> {
    const title = node.title ?? '';
    const children = Array.isArray(node.children) ? node.children : [];
    if (depth >= MAX_DEPTH) {
      this.failSubtree(ctx, node, 'max-depth-exceeded');
      return;
    }

    let folderId: string;
    try {
      folderId = await this.ensureFolder(ctx, parentId, title);
    } catch (e) {
      logger.warn('BOOKMARK_FOLDER_FAILED', { title }, e);
      this.failSubtree(ctx, node, errorMessage(e));
      return;
    }
    await this.processList(ctx, children, folderId, depth + 1);
  }

  /** Reuses an existing same-title subfolder (when deduplicating) or creates one. */
  private async ensureFolder(ctx: Context, parentId: string, title: string): Promise<string> {
    const state = await this.folderState(ctx, parentId);
    const existing = state?.folders.get(title);
    if (existing) return existing;

    const created = await browser.bookmarks.create({ parentId, title });
    state?.folders.set(title, created.id);
    // A brand-new folder is known to be empty, so no query is needed later.
    if (ctx.skipDuplicates) ctx.folderCache.set(created.id, { keys: new Set(), folders: new Map(), fresh: true });
    return created.id;
  }

  /**
   * Cached view of a folder's existing children (URL keys + subfolders by title).
   * Returns null when duplicate detection is disabled.
   */
  private async folderState(ctx: Context, parentId: string): Promise<FolderState | null> {
    if (!ctx.skipDuplicates) return null;
    let state = ctx.folderCache.get(parentId);
    if (state) return state;

    state = { keys: new Set(), folders: new Map(), fresh: false };
    try {
      const existing = await browser.bookmarks.getChildren(parentId);
      state.fresh = existing.length === 0;
      for (const child of existing) {
        if (child.url) state.keys.add(dedupKey(child.url));
        else if (!isSeparator(child) && !state.folders.has(child.title)) state.folders.set(child.title, child.id);
      }
    } catch (e) {
      logger.warn('BOOKMARKS_LIST_FAILED', { parentId }, e);
    }
    ctx.folderCache.set(parentId, state);
    return state;
  }

  // --------------------------------------------------------------- failures

  /** One URL bookmark failed. */
  private recordFailure(ctx: Context, failure: Omit<Failure, 'kind'>): void {
    ctx.failed++;
    ctx.fail(failure);
    ctx.advance();
  }

  /** A folder subtree could not be created: one failure report, URL children counted as failed. */
  private failSubtree(ctx: Context, node: BookmarkNode, reason: string): void {
    const urls = countBookmarks(node.children ?? []);
    ctx.failed += urls;
    ctx.fail({ title: node.title ?? '', reason });
    ctx.advance(urls);
  }

  /** Fails every not-yet-processed URL (used when no import can happen at all). */
  private failRemaining(ctx: Context, reason: string): void {
    const remaining = Math.max(ctx.total - ctx.processed, 0);
    ctx.failed += remaining;
    ctx.fail({ title: 'Bookmarks', reason });
    ctx.advance(remaining);
  }
}
