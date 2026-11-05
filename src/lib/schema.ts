/**
 * Backup file schema: the single source of truth for the export format.
 *
 * Schema 1.1 (backward compatible with 1.0). `index` is a tab's position in its
 * window; it lets the importer interleave grouped and ungrouped tabs in their
 * original order. Files without it restore ungrouped tabs first, then each group.
 */

export const SCHEMA_VERSION = '1.1';
export const SUPPORTED_MAJOR = 1;

/** Colors accepted by chrome.tabGroups / Firefox tabGroups. */
export const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
export type GroupColor = (typeof GROUP_COLORS)[number];

export const WINDOW_STATES = ['normal', 'maximized', 'minimized', 'fullscreen'] as const;
export type WindowState = (typeof WINDOW_STATES)[number];

export interface BackupTab {
  url: string;
  title: string;
  pinned: boolean;
  index?: number;
  active?: boolean;
  favIconUrl?: string;
  /** Firefox container (contextual identity), matched by name on restore. */
  container?: { name: string; color?: string; icon?: string };
  metadata?: Record<string, unknown>;
}

export interface BackupGroup {
  title: string;
  color: GroupColor;
  collapsed: boolean;
  tabs: BackupTab[];
  metadata?: Record<string, unknown>;
}

export interface BackupWindow {
  /** Optional label (e.g. a Session Buddy collection/folder name); shown in the import preview. */
  title?: string;
  /**
   * Optional import hints, e.g. { sessionBuddy: 'history', snapshot: 0 } for the newest
   * browser-closed session in a Session Buddy backup (older snapshots have higher numbers).
   */
  metadata?: Record<string, unknown>;
  ungroupedTabs: BackupTab[];
  groups: BackupGroup[];
  state?: WindowState;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  focused?: boolean;
}

/** Same shape as chrome.bookmarks.BookmarkTreeNode, minus volatile fields. */
export interface BookmarkNode {
  title: string;
  id?: string;
  parentId?: string;
  url?: string;
  children?: BookmarkNode[];
  folderType?: string;
  /** Firefox: 'bookmark' | 'folder' | 'separator' */
  type?: string;
  unmodifiable?: string;
  dateAdded?: number;
  index?: number;
}

export interface BackupSource {
  browser?: string;
  browserName?: string;
  extensionVersion?: string;
  groupSystem?: 'tabGroups' | 'none';
  filtersApplied?: Record<string, unknown>;
  /** Set by format converters (onetab, netscape-html, ...). */
  format?: string;
  /** Set when a converter hit the tab cap. */
  truncated?: boolean;
  [key: string]: unknown;
}

export interface Backup {
  schemaVersion: string;
  exportedAt: string | null;
  source: BackupSource;
  windows: BackupWindow[];
  bookmarks: BookmarkNode[];
}

export interface NormalizeWarnings {
  invalidTabs: number;
  invalidWindows: number;
  invalidBookmarks: number;
  newerSchema: boolean;
}

export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

export function normalizeColor(color: unknown): GroupColor {
  return GROUP_COLORS.includes(color as GroupColor) ? (color as GroupColor) : 'grey';
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const finiteOrUndefined = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);

function normalizeTab(raw: unknown, warnings: NormalizeWarnings): BackupTab | null {
  if (!isObject(raw) || typeof raw.url !== 'string' || raw.url.trim() === '') {
    warnings.invalidTabs++;
    return null;
  }
  const tab: BackupTab = {
    url: raw.url.trim(),
    title: typeof raw.title === 'string' ? raw.title : '',
    pinned: raw.pinned === true,
  };
  if (Number.isInteger(raw.index) && (raw.index as number) >= 0) tab.index = raw.index as number;
  if (raw.active === true) tab.active = true;
  if (typeof raw.favIconUrl === 'string' && raw.favIconUrl) tab.favIconUrl = raw.favIconUrl;
  if (isObject(raw.container) && typeof raw.container.name === 'string' && raw.container.name.trim()) {
    tab.container = { name: raw.container.name.trim().slice(0, 100) };
    if (typeof raw.container.color === 'string') tab.container.color = raw.container.color;
    if (typeof raw.container.icon === 'string') tab.container.icon = raw.container.icon;
  }
  if (isObject(raw.metadata)) tab.metadata = raw.metadata;
  return tab;
}

function normalizeTabs(list: unknown, warnings: NormalizeWarnings): BackupTab[] {
  if (!Array.isArray(list)) return [];
  return list.map((t) => normalizeTab(t, warnings)).filter((t): t is BackupTab => t !== null);
}

function normalizeWindow(raw: unknown, warnings: NormalizeWarnings): BackupWindow | null {
  if (!isObject(raw)) {
    warnings.invalidWindows++;
    return null;
  }
  const win: BackupWindow = {
    ungroupedTabs: normalizeTabs(raw.ungroupedTabs ?? raw.tabs, warnings),
    groups: [],
  };
  if (Array.isArray(raw.groups)) {
    for (const g of raw.groups) {
      if (!isObject(g)) continue;
      const tabs = normalizeTabs(g.tabs, warnings);
      if (tabs.length === 0) continue;
      win.groups.push({
        title: typeof g.title === 'string' ? g.title : '',
        color: normalizeColor(g.color),
        collapsed: g.collapsed === true,
        tabs,
        ...(isObject(g.metadata) ? { metadata: g.metadata } : {}),
      });
    }
  }
  if (WINDOW_STATES.includes(raw.state as WindowState)) win.state = raw.state as WindowState;
  for (const k of ['left', 'top', 'width', 'height'] as const) {
    const v = finiteOrUndefined(raw[k]);
    if (v !== undefined) win[k] = v;
  }
  if (raw.focused === true) win.focused = true;
  if (typeof raw.title === 'string' && raw.title.trim()) win.title = raw.title.trim().slice(0, 200);
  if (isObject(raw.metadata)) win.metadata = raw.metadata;
  if (win.ungroupedTabs.length === 0 && win.groups.length === 0) return null;
  return win;
}

/** Keeps only structurally valid bookmark nodes; drops unknown keys. */
function normalizeBookmarkNode(raw: unknown, warnings: NormalizeWarnings, depth = 0): BookmarkNode | null {
  if (!isObject(raw) || depth > 100) {
    warnings.invalidBookmarks++;
    return null;
  }
  const node: BookmarkNode = { title: typeof raw.title === 'string' ? raw.title : '' };
  for (const k of ['id', 'parentId', 'folderType', 'type'] as const) {
    if (typeof raw[k] === 'string') node[k] = raw[k] as string;
  }
  if (typeof raw.url === 'string' && raw.url) node.url = raw.url;
  if (typeof raw.unmodifiable === 'string') node.unmodifiable = raw.unmodifiable;
  if (typeof raw.dateAdded === 'number' && Number.isFinite(raw.dateAdded)) node.dateAdded = raw.dateAdded;
  if (Number.isInteger(raw.index)) node.index = raw.index as number;
  if (Array.isArray(raw.children)) {
    node.children = raw.children
      .map((c) => normalizeBookmarkNode(c, warnings, depth + 1))
      .filter((c): c is BookmarkNode => c !== null);
  }
  return node;
}

/**
 * Validates and normalises a parsed backup object.
 * @throws {BackupFormatError} if the input is not a backup at all
 */
export function normalizeBackup(raw: unknown): { data: Backup; warnings: NormalizeWarnings } {
  if (!isObject(raw)) throw new BackupFormatError('Backup must be a JSON object.');
  const hasWindows = Array.isArray(raw.windows);
  const hasBookmarks = Array.isArray(raw.bookmarks);
  if (!hasWindows && !hasBookmarks) {
    throw new BackupFormatError('Backup has neither "windows" nor "bookmarks".');
  }

  const warnings: NormalizeWarnings = { invalidTabs: 0, invalidWindows: 0, invalidBookmarks: 0, newerSchema: false };
  const version = typeof raw.schemaVersion === 'string' ? raw.schemaVersion : '1.0';
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isFinite(major) && major > SUPPORTED_MAJOR) warnings.newerSchema = true;

  const data: Backup = {
    schemaVersion: version,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : null,
    source: isObject(raw.source) ? (raw.source as BackupSource) : {},
    windows: hasWindows
      ? (raw.windows as unknown[]).map((w) => normalizeWindow(w, warnings)).filter((w): w is BackupWindow => w !== null)
      : [],
    bookmarks: hasBookmarks
      ? (raw.bookmarks as unknown[])
          .map((b) => normalizeBookmarkNode(b, warnings))
          .filter((b): b is BookmarkNode => b !== null)
      : [],
  };
  return { data, warnings };
}

export function countWindowTabs(win: Pick<BackupWindow, 'ungroupedTabs' | 'groups'>): number {
  return (win.ungroupedTabs?.length ?? 0) + (win.groups ?? []).reduce((sum, g) => sum + (g.tabs?.length ?? 0), 0);
}

export function countTabs(data: { windows?: BackupWindow[] } | null | undefined): number {
  if (!Array.isArray(data?.windows)) return 0;
  return data.windows.reduce((total, w) => total + countWindowTabs(w), 0);
}

export function countGroups(data: { windows?: BackupWindow[] } | null | undefined): number {
  if (!Array.isArray(data?.windows)) return 0;
  return data.windows.reduce((total, w) => total + (w.groups?.length ?? 0), 0);
}

/** Number of URL bookmarks (not folders) in a tree. */
export function countBookmarks(nodes: BookmarkNode[] | null | undefined): number {
  if (!Array.isArray(nodes)) return 0;
  let n = 0;
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    if (node?.url) n++;
    if (Array.isArray(node?.children)) stack.push(...node.children);
  }
  return n;
}

/** Number of bookmarklets (javascript: bookmarks) in a tree. */
export function countBookmarklets(nodes: BookmarkNode[] | null | undefined): number {
  if (!Array.isArray(nodes)) return 0;
  let n = 0;
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop();
    if (node?.url && /^\s*javascript:/i.test(node.url)) n++;
    if (Array.isArray(node?.children)) stack.push(...node.children);
  }
  return n;
}

export interface OrderedEntry {
  tab: BackupTab;
  /** -1 = ungrouped */
  groupIndex: number;
}

/**
 * Flattens a window into the order tabs should be created in.
 * Uses `index` when every tab has one, otherwise ungrouped tabs then groups.
 * Pinned tabs always come first (browsers keep them at the start of a window).
 */
export function orderedWindowTabs(win: Pick<BackupWindow, 'ungroupedTabs' | 'groups'>): OrderedEntry[] {
  const entries: OrderedEntry[] = [];
  (win.ungroupedTabs ?? []).forEach((tab) => entries.push({ tab, groupIndex: -1 }));
  (win.groups ?? []).forEach((g, gi) => g.tabs.forEach((tab) => entries.push({ tab, groupIndex: gi })));

  const allIndexed = entries.length > 0 && entries.every((e) => Number.isInteger(e.tab.index));
  if (allIndexed) entries.sort((a, b) => (a.tab.index ?? 0) - (b.tab.index ?? 0)); // stable
  return [...entries.filter((e) => e.tab.pinned), ...entries.filter((e) => !e.tab.pinned)];
}

/**
 * Whether a window should start selected in the import preview. Older snapshots of a
 * Session Buddy history mostly repeat the newest one, so only the newest is pre-selected.
 */
export function selectedByDefault(win: Pick<BackupWindow, 'metadata'>): boolean {
  const snapshot = win.metadata?.snapshot;
  return !(win.metadata?.sessionBuddy === 'history' && typeof snapshot === 'number' && snapshot > 0);
}

/** An empty backup with the current schema, for format converters and the exporter. */
export function emptyBackup(source: BackupSource = {}): Backup {
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    source,
    windows: [],
    bookmarks: [],
  };
}
