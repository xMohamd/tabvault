/**
 * Shared contracts between the background script, the library modules and the popup.
 * Changing a type here is a protocol change: update both sides.
 */
import type { Backup, NormalizeWarnings } from './schema';
import type { BrowserInfo } from './browser-detect';

// ---------- export ----------

export interface ExportFilters {
  excludeInternal?: boolean;
  /** Already-normalized or raw domains; the exporter normalizes them. */
  domains?: string[];
  applyToBookmarks?: boolean;
}

export interface ExportOptions {
  includeTabs: boolean;
  includeBookmarks: boolean;
  /** Keep javascript: bookmarks. Default true. */
  includeBookmarklets?: boolean;
  includeFavicons?: boolean;
  includeIncognito?: boolean;
  unwrapPlaceholders?: boolean;
  includeWindowLayout?: boolean;
  filters?: ExportFilters;
}

export interface ExportStats {
  windows: number;
  tabs: number;
  groups: number;
  bookmarks: number;
  /** javascript: bookmarks included in `bookmarks` (absent in snapshots made before v2.0). */
  bookmarklets?: number;
  skippedTabs: number;
}

// ---------- import ----------

export type RestoreMode = 'discard' | 'lazy' | 'load';
export type BookmarkStrategy = 'merge' | 'folder' | 'replace';

export interface Failure {
  kind: 'tab' | 'group' | 'bookmark';
  url?: string;
  title?: string;
  /** A RestoreFailureReason code, 'unsupported-url', 'window-create-failed', or a raw error message. */
  reason: string;
}

export interface ImportOptions {
  importTabs: boolean;
  importBookmarks: boolean;
  bookmarkStrategy?: BookmarkStrategy;
  skipDuplicateBookmarks?: boolean;
  /** Restore javascript: bookmarks. Default true. */
  importBookmarklets?: boolean;
  restoreMode?: RestoreMode;
  restoreWindowLayout?: boolean;
  skipOpenTabs?: boolean;
  skipBlankTabs?: boolean;
  focusRestored?: boolean;
}

export interface ImportProgress {
  phase: 'bookmarks' | 'tabs' | 'done';
  current: number;
  total: number;
  message: string;
}

export interface ImportResult {
  tabs: number;
  groups: number;
  windows: number;
  tabsSkipped: number;
  tabsFailed: number;
  bookmarks: number;
  bookmarksSkipped: number;
  bookmarksFailed: number;
  /** Capped at MAX_FAILURES entries; the counters above stay exact. */
  failures: Failure[];
  /** Human-readable phase errors. */
  errors: string[];
  warnings: NormalizeWarnings;
  cancelled: boolean;
}

export type ImportStatus = 'idle' | 'running' | 'cancelling' | 'done' | 'cancelled' | 'error';

export interface ImportState {
  status: ImportStatus;
  phase?: ImportProgress['phase'] | 'starting';
  current: number;
  total: number;
  message: string;
  result?: ImportResult;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

// ---------- snapshots ----------

export type SnapshotReason = 'scheduled' | 'manual' | 'pre-replace' | 'pre-import';
export type ScheduleFrequency = 'hourly' | 'daily' | 'weekly';

export interface ScheduleSettings {
  enabled: boolean;
  frequency: ScheduleFrequency;
  /** 1..50 */
  keep: number;
  includeBookmarks: boolean;
}

export interface SnapshotMeta {
  id: string;
  createdAt: string;
  reason: SnapshotReason;
  stats: ExportStats;
  bytes: number;
  hash: string;
}

export interface LastRun {
  at: string;
  ok: boolean;
  error?: string;
  skipped?: 'unchanged';
}

export interface DiagnosticsReport {
  generatedAt: string;
  extensionVersion: string;
  userAgent: string;
  browser: BrowserInfo;
  importState: Omit<ImportState, 'result'> & { result?: Omit<ImportResult, 'failures'> & { failureCount: number } };
  lastAutoBackup: LastRun | null;
  /** No data payloads (they can hold URLs): only the action trail and errors. */
  logs: Array<{ timestamp: string; level: string; action: string; error: { message: string; stack?: string } | null }>;
}

// ---------- messaging protocol (popup -> background) ----------

type Ok<T = object> = { ok: true } & T;
type Err = { ok: false; error: string; cancelled?: boolean };
export type Reply<T = object> = Ok<T> | Err;

/** Request payloads and their replies, keyed by message type. */
export interface Protocol {
  GET_STATE: { req: object; res: Reply<{ browser: BrowserInfo; importState: ImportState }> };
  EXPORT: { req: { options: ExportOptions; saveAs?: boolean }; res: Reply<{ stats: ExportStats; filename: string }> };
  IMPORT_START: { req: { data: Backup; options: ImportOptions }; res: Reply };
  IMPORT_CANCEL: { req: object; res: Reply };
  DIAGNOSTICS: { req: object; res: Reply<{ report: DiagnosticsReport }> };
  SNAPSHOTS_LIST: {
    req: object;
    res: Reply<{ snapshots: SnapshotMeta[]; settings: ScheduleSettings; lastRun: LastRun | null }>;
  };
  SNAPSHOT_CREATE: { req: object; res: Reply<{ snapshot: SnapshotMeta | null }> };
  SNAPSHOT_DELETE: { req: { id: string }; res: Reply };
  SNAPSHOT_GET: { req: { id: string }; res: Reply<{ data: Backup }> };
  SNAPSHOT_DOWNLOAD: { req: { id: string }; res: Reply<{ filename: string }> };
  SCHEDULE_SET: { req: { settings: Partial<ScheduleSettings> }; res: Reply<{ settings: ScheduleSettings }> };
}

export type MessageType = keyof Protocol;
export type Request<K extends MessageType = MessageType> = { type: K } & Protocol[K]['req'];
export type Response<K extends MessageType> = Protocol[K]['res'];

/** Broadcast from the background to any open extension page. */
export interface ImportStateBroadcast {
  type: 'IMPORT_STATE';
  state: ImportState;
}
