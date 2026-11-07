/**
 * Background (service worker on Chrome, event page on Firefox).
 *
 * Long-running work lives here, not in the popup: creating a window steals
 * focus, which closes the popup and would kill an import running inside it.
 * The popup only sends commands (see `Protocol` in lib/types.ts) and renders
 * state broadcast as { type: 'IMPORT_STATE', state }.
 */
import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { logger } from '@/lib/logger';
import { detectBrowserAsync } from '@/lib/browser-detect';
import { UniversalExporter } from '@/lib/exporter';
import { UniversalImporter } from '@/lib/importer';
import * as scheduler from '@/lib/backup-scheduler';
import { registerQuickActions } from '@/lib/quick-actions';
import { saveJsonFile } from '@/lib/downloads';
import { encryptBackup } from '@/lib/crypto';
import { t } from '@/lib/i18n';
import { searchBackups } from '@/lib/snapshot-search';
import type { Backup } from '@/lib/schema';
import type {
  DiagnosticsReport,
  SnapshotMeta,
  ImportOptions,
  ImportResult,
  ImportState,
  ImportStateBroadcast,
  MessageType,
  Protocol,
  Request,
  Response,
} from '@/lib/types';

const IMPORT_STATE_KEY = 'importState';
const KEEPALIVE_INTERVAL_MS = 20_000;
const PERSIST_THROTTLE_MS = 1_000;
const EXPORT_FILENAME_PREFIX = 'tabs-export-';
const SNAPSHOT_FILENAME_PREFIX = 'tabs-snapshot-';

let importState: ImportState = { status: 'idle', current: 0, total: 0, message: '' };
let importCancelled = false;
let lastPersist = 0;

type Handler<K extends MessageType> = (msg: Request<K>) => Promise<Response<K>>;
type Handlers = { [K in MessageType]: Handler<K> };

const handlers: Handlers = {
  GET_STATE: async () => ({ ok: true, browser: await detectBrowserAsync(), importState }),
  EXPORT: (msg) => handleExport(msg.options, msg.saveAs ?? true),
  EXPORT_PREVIEW: async (msg) => {
    const info = await detectBrowserAsync();
    const { stats } = await new UniversalExporter({ browser: info }).export(msg.options);
    return { ok: true, stats };
  },
  IMPORT_START: (msg) => startImport(msg.data, msg.options),
  IMPORT_CANCEL: async () => {
    if (importState.status === 'running') {
      importCancelled = true;
      setImportState({ status: 'cancelling' });
    }
    return { ok: true };
  },
  DIAGNOSTICS: async () => ({ ok: true, report: await buildDiagnostics() }),
  SNAPSHOTS_LIST: async () => ({
    ok: true,
    snapshots: await scheduler.listSnapshots(),
    settings: await scheduler.getSettings(),
    lastRun: await scheduler.getLastRun(),
  }),
  SNAPSHOT_CREATE: async () => ({
    ok: true,
    snapshot: await scheduler.createSnapshot('manual', { browser: await detectBrowserAsync() }),
  }),
  SNAPSHOT_DELETE: async (msg) => {
    await scheduler.deleteSnapshot(msg.id);
    return { ok: true };
  },
  SNAPSHOT_GET: async (msg) => {
    const data = await scheduler.getSnapshot(msg.id);
    return data ? { ok: true, data } : { ok: false, error: 'Snapshot not found.' };
  },
  SNAPSHOT_DOWNLOAD: async (msg) => {
    const data = await scheduler.getSnapshot(msg.id);
    if (!data) return { ok: false, error: 'Snapshot not found.' };
    const stamp = (data.exportedAt ?? new Date().toISOString()).slice(0, 19).replace(/[:T]/g, '-');
    return downloadJson(data, `${SNAPSHOT_FILENAME_PREFIX}${stamp}.json`, true);
  },
  SEARCH_SNAPSHOTS: async (msg) => {
    const snapshots = await scheduler.getAllSnapshots();
    const sources = snapshots.map(({ meta, data }) => ({
      id: meta.id,
      label: snapshotLabel(meta),
      date: meta.createdAt,
      data,
    }));
    const { results, total } = searchBackups(sources, String(msg.query ?? ''), { limit: msg.limit });
    return { ok: true, results, total, searched: sources.length };
  },
  SCHEDULE_SET: async (msg) => ({ ok: true, settings: await scheduler.saveSettings(msg.settings ?? {}) }),
};

export default defineBackground(() => {
  registerQuickActions();
  browser.runtime.onInstalled.addListener((details) => {
    logger.info('EXTENSION_INSTALLED', { reason: details.reason });
    void scheduler.ensureAlarm().catch((e: unknown) => logger.warn('ALARM_SETUP_FAILED', {}, e));
  });
  browser.runtime.onStartup.addListener(() => {
    void scheduler.ensureAlarm().catch((e: unknown) => logger.warn('ALARM_SETUP_FAILED', {}, e));
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    void scheduler.handleAlarm(alarm);
  });

  void loadImportState();

  browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    // Only our own pages may drive the background.
    if (sender.id !== browser.runtime.id) return false;
    const type = (msg as { type?: unknown } | null)?.type;
    if (typeof type !== 'string' || !(type in handlers)) return false;

    const handler = handlers[type as MessageType] as (m: unknown) => Promise<unknown>;
    handler(msg)
      .then(sendResponse)
      .catch((error: unknown) => {
        logger.error('MESSAGE_HANDLER_FAILED', { type }, error);
        sendResponse({ ok: false, error: errorMessage(error) });
      });
    return true; // async response
  });
});

// ---------- search ----------

const REASON_LABELS: Record<string, [key: string, fallback: string]> = {
  scheduled: ['reasonScheduled', 'Scheduled'],
  manual: ['reasonManual', 'Manual'],
  quick: ['reasonQuick', 'Quick save'],
  'pre-replace': ['reasonPreReplace', 'Before replace'],
  'pre-import': ['reasonPreImport', 'Before import'],
};
const labelDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** "Manual · Nov 8, 2026, 10:00 AM"; quick saves name what was saved instead of the reason. */
function snapshotLabel(meta: SnapshotMeta): string {
  const [key, fallback] = REASON_LABELS[meta.reason] ?? [meta.reason, String(meta.reason)];
  const translated = t(key);
  const reason = translated === key ? fallback : translated;
  const what = meta.reason === 'quick' && meta.scope?.title ? meta.scope.title : reason;
  const when = Number.isFinite(Date.parse(meta.createdAt)) ? labelDate.format(new Date(meta.createdAt)) : '';
  return when ? `${what} · ${when}` : what;
}

// ---------- export ----------

async function handleExport(
  options: Protocol['EXPORT']['req']['options'],
  saveAs: boolean,
): Promise<Response<'EXPORT'>> {
  const info = await detectBrowserAsync();
  if (!info.features.downloads) {
    return { ok: false, error: 'This browser does not support saving files from extensions.' };
  }
  // The password stays out of the exporter, which logs its options.
  const { password, ...exportOptions } = options;
  const { data, stats } = await new UniversalExporter({ browser: info }).export(exportOptions);
  const date = new Date().toISOString().slice(0, 10); // ISO keeps files sortable by name
  if (password) {
    const envelope = await encryptBackup(JSON.stringify(data), password);
    const saved = await saveJsonFile(envelope, `${EXPORT_FILENAME_PREFIX}${date}.encrypted.json`, { saveAs });
    return saved.ok ? { ok: true, filename: saved.filename, stats } : saved;
  }
  const result = await downloadJson(data, `${EXPORT_FILENAME_PREFIX}${date}.json`, saveAs);
  return result.ok ? { ...result, stats } : result;
}

/** Saves JSON through the shared downloads helper; the reply shape is the protocol's. */
async function downloadJson(data: Backup, filename: string, saveAs: boolean): Promise<Response<'SNAPSHOT_DOWNLOAD'>> {
  const result = await saveJsonFile(data, filename, { saveAs });
  return result.ok ? { ok: true, filename: result.filename } : result;
}

// ---------- import ----------

async function startImport(data: Backup, options: ImportOptions): Promise<Response<'IMPORT_START'>> {
  if (importState.status === 'running' || importState.status === 'cancelling') {
    return { ok: false, error: 'A restore is already running.' };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'No backup data received.' };

  importCancelled = false;
  setImportState({
    status: 'running',
    phase: 'starting',
    current: 0,
    total: 0,
    message: '',
    result: undefined,
    error: undefined,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
  });

  // Detached, so the message is answered immediately; progress is broadcast.
  void runImport(data, options);
  return { ok: true };
}

async function runImport(data: Backup, options: ImportOptions): Promise<void> {
  const stopKeepAlive = keepAlive();
  try {
    const info = await detectBrowserAsync();
    const result = await new UniversalImporter({ browser: info }).import(data, {
      ...options,
      isCancelled: () => importCancelled,
      // Safety net: replace deletes bookmarks, so snapshot them first.
      beforeReplace: async () => {
        await scheduler.createSnapshot('pre-replace', { browser: info, includeBookmarks: true });
      },
      onProgress: ({ phase, current, total, message }) => {
        setImportState({ phase, current, total, message }, { persist: false });
      },
    });
    setImportState({
      status: result.cancelled ? 'cancelled' : 'done',
      phase: 'done',
      result,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('IMPORT_FAILED', {}, error);
    setImportState({ status: 'error', error: errorMessage(error), finishedAt: new Date().toISOString() });
  } finally {
    stopKeepAlive();
  }
}

/**
 * Chrome stops an idle worker after ~30s; extension API calls reset that timer.
 * A cheap periodic call covers long gaps (e.g. a slow bookmark tree).
 */
function keepAlive(): () => void {
  const timer = setInterval(() => {
    void browser.runtime.getPlatformInfo().catch(() => {});
  }, KEEPALIVE_INTERVAL_MS);
  return () => clearInterval(timer);
}

function setImportState(patch: Partial<ImportState>, { persist = true } = {}): void {
  importState = { ...importState, ...patch };
  const broadcast: ImportStateBroadcast = { type: 'IMPORT_STATE', state: importState };
  browser.runtime.sendMessage(broadcast).catch(() => {
    // No page is listening (popup closed): fine.
  });
  // Progress ticks are frequent; persist them at most once a second.
  const now = Date.now();
  if (persist || now - lastPersist > PERSIST_THROTTLE_MS) {
    lastPersist = now;
    void storageArea().set({ [IMPORT_STATE_KEY]: importState }).catch(() => {});
  }
}

async function loadImportState(): Promise<void> {
  try {
    const stored = (await storageArea().get(IMPORT_STATE_KEY))[IMPORT_STATE_KEY] as ImportState | undefined;
    if (!stored) return;
    // A "running" state left by a terminated worker can't be resumed.
    if (stored.status === 'running' || stored.status === 'cancelling') {
      stored.status = 'error';
      stored.error = 'The restore was interrupted because the browser stopped the extension.';
    }
    importState = stored;
  } catch (e) {
    logger.warn('IMPORT_STATE_LOAD_FAILED', {}, e);
  }
}

function storageArea(): Browser.storage.StorageArea {
  return browser.storage.session ?? browser.storage.local;
}

// ---------- diagnostics ----------

async function buildDiagnostics(): Promise<DiagnosticsReport> {
  return {
    generatedAt: new Date().toISOString(),
    extensionVersion: browser.runtime.getManifest().version,
    userAgent: navigator.userAgent,
    browser: await detectBrowserAsync(),
    importState: { ...importState, result: importState.result && summarizeResult(importState.result) },
    lastAutoBackup: await scheduler.getLastRun().catch(() => null),
    // URLs in log payloads could be private: keep only the action trail and errors.
    logs: logger.getLogs().map(({ timestamp, level, action, error }) => ({ timestamp, level, action, error })),
  };
}

function summarizeResult(result: ImportResult): Omit<ImportResult, 'failures'> & { failureCount: number } {
  const { failures, ...rest } = result;
  return { ...rest, failureCount: failures.length };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
