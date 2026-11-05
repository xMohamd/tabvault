/**
 * Automatic and safety backups.
 *
 * Snapshots are full backup objects stored in browser.storage.local:
 *   autoBackup:settings   user settings
 *   autoBackup:lastRun    outcome of the last scheduled run
 *   snapshots:index       array of snapshot metadata, newest first
 *   snapshot:<id>         the backup body
 */
import { browser } from 'wxt/browser';
import { detectBrowserAsync, type BrowserInfo } from './browser-detect';
import { logger } from './logger';
import { saveJsonFile } from './downloads';
// Static on purpose: Chrome forbids dynamic import() inside service workers.
import { UniversalExporter } from './exporter';
import type { Backup } from './schema';
import type {
  ExportOptions,
  ExportStats,
  LastRun,
  ScheduleFrequency,
  ScheduleSettings,
  SnapshotMeta,
  SnapshotReason,
} from './types';

export const SCHEDULE_ALARM = 'tabvault:auto-backup';
export const DEFAULT_SETTINGS: ScheduleSettings = {
  enabled: false,
  frequency: 'daily',
  keep: 7,
  includeBookmarks: true,
  saveToFiles: false,
};

const SETTINGS_KEY = 'autoBackup:settings';
const LAST_RUN_KEY = 'autoBackup:lastRun';
const INDEX_KEY = 'snapshots:index';
const BODY_PREFIX = 'snapshot:';

const PERIODS: Record<ScheduleFrequency, number> = { hourly: 60, daily: 1440, weekly: 10080 };
const KEEP_MIN = 1;
const KEEP_MAX = 50;
const KEEP_SAFETY = 3;
const SAFETY_REASONS = new Set<string>(['pre-replace', 'pre-import']);
const REASONS = new Set<string>(['scheduled', 'manual', 'quick', 'pre-replace', 'pre-import']);

const isFrequency = (v: unknown): v is ScheduleFrequency => typeof v === 'string' && Object.hasOwn(PERIODS, v);

interface ExporterLike {
  export(options: ExportOptions): Promise<{ data: Backup; stats: ExportStats }>;
}
export type ExporterFactory = (browser: BrowserInfo) => ExporterLike | Promise<ExporterLike>;

const defaultExporterFactory: ExporterFactory = (info) => new UniversalExporter({ browser: info });

/** Test-only seam: replace how the exporter is built. */
let exporterFactory: ExporterFactory = defaultExporterFactory;

/** TEST ONLY. Overrides the exporter factory. Call with no argument to restore the default. */
export function _setExporterFactory(fn?: ExporterFactory): void {
  exporterFactory = fn ?? defaultExporterFactory;
}

const storage = () => browser.storage.local;
const bodyKey = (id: string) => `${BODY_PREFIX}${id}`;

// ---------- settings ----------

/** Coerces arbitrary input into valid settings, falling back to defaults per field. */
function validateSettings(raw: Record<string, unknown> = {}): ScheduleSettings {
  const keep = Number.parseInt(String(raw.keep), 10);
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
    frequency: isFrequency(raw.frequency) ? raw.frequency : DEFAULT_SETTINGS.frequency,
    keep: Number.isInteger(keep) && keep >= KEEP_MIN && keep <= KEEP_MAX ? keep : DEFAULT_SETTINGS.keep,
    includeBookmarks:
      typeof raw.includeBookmarks === 'boolean' ? raw.includeBookmarks : DEFAULT_SETTINGS.includeBookmarks,
    saveToFiles: typeof raw.saveToFiles === 'boolean' ? raw.saveToFiles : DEFAULT_SETTINGS.saveToFiles,
  };
}

export async function getSettings(): Promise<ScheduleSettings> {
  const stored: unknown = (await storage().get(SETTINGS_KEY))[SETTINGS_KEY];
  return validateSettings(stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {});
}

/**
 * Validates, persists and applies settings.
 * @throws {RangeError} if `keep` or `frequency` is explicitly invalid
 */
export async function saveSettings(partial: Partial<ScheduleSettings> = {}): Promise<ScheduleSettings> {
  if ('keep' in partial) {
    const keep = Number(partial.keep);
    if (!Number.isInteger(keep) || keep < KEEP_MIN || keep > KEEP_MAX) {
      throw new RangeError(`keep must be an integer between ${KEEP_MIN} and ${KEEP_MAX}`);
    }
  }
  if ('frequency' in partial && !isFrequency(partial.frequency)) {
    throw new RangeError(`frequency must be one of: ${Object.keys(PERIODS).join(', ')}`);
  }
  const next = validateSettings({ ...(await getSettings()), ...partial });
  await storage().set({ [SETTINGS_KEY]: next });
  await ensureAlarm();
  return next;
}

// ---------- alarm ----------

/**
 * Creates, replaces or clears the alarm to match settings. An identical existing
 * alarm is left alone so service-worker restarts don't reset the schedule.
 */
export async function ensureAlarm(): Promise<void> {
  const alarms = browser.alarms as typeof browser.alarms | undefined;
  if (!alarms) return;
  const settings = await getSettings();
  const existing = await alarms.get(SCHEDULE_ALARM);
  if (!settings.enabled) {
    if (existing) await alarms.clear(SCHEDULE_ALARM);
    return;
  }
  const period = PERIODS[settings.frequency];
  if (existing && existing.periodInMinutes === period) return;
  await alarms.create(SCHEDULE_ALARM, { delayInMinutes: period, periodInMinutes: period });
}

/** @returns snapshot meta, or null if not ours / skipped / failed */
export async function handleAlarm(alarm: { name?: string } | null | undefined): Promise<SnapshotMeta | null> {
  if (alarm?.name !== SCHEDULE_ALARM) return null;
  try {
    const { meta, skipped, fileError } = await enqueue(() => runSnapshot('scheduled', {}));
    const at = new Date().toISOString();
    // A failed file write keeps the snapshot: ok stays true and `error` carries the warning.
    await setLastRun(
      skipped
        ? { at, ok: true, skipped }
        : fileError
          ? { at, ok: true, error: `File not saved: ${fileError}` }
          : { at, ok: true },
    );
    return meta;
  } catch (error) {
    logger.error('AUTO_BACKUP_FAILED', {}, error);
    await setLastRun({
      at: new Date().toISOString(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function setLastRun(run: LastRun): Promise<void> {
  try {
    await storage().set({ [LAST_RUN_KEY]: run });
  } catch (error) {
    logger.error('AUTO_BACKUP_LASTRUN_FAILED', {}, error);
  }
}

export async function getLastRun(): Promise<LastRun | null> {
  const run: unknown = (await storage().get(LAST_RUN_KEY))[LAST_RUN_KEY];
  return (run as LastRun | undefined) ?? null;
}

// ---------- snapshots ----------

let chain: Promise<unknown> = Promise.resolve();

/** Runs tasks strictly one after another; a failed task doesn't block the next. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = chain.then(task);
  chain = result.catch(() => {});
  return result;
}

/** FNV-1a 32-bit hash of a string, as 8 hex chars. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Hash of the content that matters (ignores exportedAt). */
function contentHash(data: Pick<Backup, 'windows' | 'bookmarks'> | null | undefined): string {
  return fnv1a(JSON.stringify({ windows: data?.windows ?? [], bookmarks: data?.bookmarks ?? [] }));
}

async function readIndex(): Promise<SnapshotMeta[]> {
  const index: unknown = (await storage().get(INDEX_KEY))[INDEX_KEY];
  return Array.isArray(index) ? (index as SnapshotMeta[]) : [];
}

const time = (m: SnapshotMeta) => Date.parse(m.createdAt);
const newestFirst = (a: SnapshotMeta, b: SnapshotMeta) => time(b) - time(a);

/** Pure: decides which snapshots to drop. `kept` is newest first. */
function prune(index: SnapshotMeta[], keep: number): { kept: SnapshotMeta[]; removed: SnapshotMeta[] } {
  const sorted = [...index].sort(newestFirst);
  let regular = 0;
  let safety = 0;
  const kept: SnapshotMeta[] = [];
  const removed: SnapshotMeta[] = [];
  for (const meta of sorted) {
    const isSafety = SAFETY_REASONS.has(meta.reason);
    const ok = isSafety ? ++safety <= KEEP_SAFETY : ++regular <= keep;
    (ok ? kept : removed).push(meta);
  }
  return { kept, removed };
}

interface SnapshotOptions {
  browser?: BrowserInfo;
  includeBookmarks?: boolean;
  /** Quick saves: only this window or tab group; `title` labels the snapshot in the list. */
  scope?: { windowId?: number; groupId?: number; title?: string };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `TabVault/tabs-backup-YYYY-MM-DD_HH-mm-ss.json` in local time. */
export function backupFilename(date: Date = new Date()): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `TabVault/tabs-backup-${day}_${clock}.json`;
}

/**
 * Deletes the file of an automatically pruned snapshot, then its entry in the downloads list.
 * Each step is best-effort: the user may already have moved or deleted the file.
 */
async function removeBackupFile(meta: SnapshotMeta): Promise<void> {
  if (!meta.file) return;
  const { downloadId } = meta.file;
  try {
    await browser.downloads.removeFile(downloadId);
  } catch (error) {
    logger.warn('BACKUP_FILE_REMOVE_FAILED', { id: meta.id, downloadId }, error);
  }
  try {
    await browser.downloads.erase({ id: downloadId });
  } catch (error) {
    logger.warn('BACKUP_FILE_ERASE_FAILED', { id: meta.id, downloadId }, error);
  }
}

async function runSnapshot(
  reason: string,
  { browser: given, includeBookmarks, scope }: SnapshotOptions = {},
): Promise<{ meta: SnapshotMeta | null; skipped: 'unchanged' | null; fileError?: string }> {
  if (!REASONS.has(reason)) throw new RangeError(`Unknown snapshot reason: ${reason}`);
  const settings = await getSettings();
  const resolvedBrowser = given ?? (await detectBrowserAsync());
  const withBookmarks = includeBookmarks ?? settings.includeBookmarks;

  const exporter = await exporterFactory(resolvedBrowser);
  const { data, stats } = await exporter.export({
    includeTabs: true,
    includeBookmarks: withBookmarks,
    includeFavicons: false,
    filters: { excludeInternal: true },
    ...(scope ? { scope: { windowId: scope.windowId, groupId: scope.groupId } } : {}),
  });

  const hash = contentHash(data);
  const index = await readIndex();
  const newest = [...index].sort(newestFirst)[0];
  if (reason === 'scheduled' && newest?.hash === hash) {
    logger.info('AUTO_BACKUP_SKIPPED', { reason: 'unchanged' });
    return { meta: null, skipped: 'unchanged' };
  }

  const json = JSON.stringify(data);
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const meta: SnapshotMeta = {
    id,
    createdAt: new Date().toISOString(),
    reason: reason as SnapshotReason,
    stats,
    bytes: json.length,
    hash,
    ...(scope ? { scope } : {}),
  };

  // Scheduled backups can also be written to Downloads. A failed write never fails the snapshot.
  let fileError: string | undefined;
  if (reason === 'scheduled' && settings.saveToFiles) {
    try {
      const saved = await saveJsonFile(data, backupFilename(), { saveAs: false });
      if (saved.ok) meta.file = { downloadId: saved.downloadId, filename: saved.filename };
      else fileError = saved.error;
    } catch (error) {
      fileError = error instanceof Error ? error.message : String(error);
    }
    if (fileError) logger.warn('BACKUP_FILE_SAVE_FAILED', { id }, new Error(fileError));
  }

  await storage().set({ [bodyKey(id)]: data });
  const { kept, removed } = prune([meta, ...index], settings.keep);
  try {
    await storage().set({ [INDEX_KEY]: kept });
  } catch (error) {
    await storage().remove(bodyKey(id)).catch(() => {});
    if (meta.file) await removeBackupFile(meta);
    throw error;
  }
  if (removed.length) await storage().remove(removed.map((m) => bodyKey(m.id)));
  // Automatic pruning deletes the files the extension created.
  for (const old of removed) await removeBackupFile(old);

  logger.info('SNAPSHOT_CREATED', { id, reason, bytes: meta.bytes, pruned: removed.length });
  return { meta, skipped: null, ...(fileError ? { fileError } : {}) };
}

/**
 * Exports the current browser state and stores it as a snapshot.
 * Scheduled snapshots identical to the newest one are skipped (returns null).
 */
export async function createSnapshot(
  reason: SnapshotReason,
  options: SnapshotOptions = {},
): Promise<SnapshotMeta | null> {
  const { meta } = await enqueue(() => runSnapshot(reason, options));
  return meta;
}

/** @returns newest first */
export async function listSnapshots(): Promise<SnapshotMeta[]> {
  return (await readIndex()).sort(newestFirst);
}

/** @returns full backup data */
export async function getSnapshot(id: string): Promise<Backup | null> {
  const body: unknown = (await storage().get(bodyKey(id)))[bodyKey(id)];
  return (body as Backup | undefined) ?? null;
}

/**
 * Deletes a snapshot from the extension's storage only. Its backup file (`meta.file`) is
 * deliberately left alone: the user asked to delete the snapshot, not their file. Only
 * automatic pruning removes files the extension created.
 */
export async function deleteSnapshot(id: string): Promise<void> {
  await enqueue(async () => {
    const index = await readIndex();
    await storage().set({ [INDEX_KEY]: index.filter((m) => m.id !== id) });
    await storage().remove(bodyKey(id));
  });
}
