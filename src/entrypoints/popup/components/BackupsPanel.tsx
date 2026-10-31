import { useCallback, useEffect, useRef, useState } from 'react';
import { send } from '@/lib/messaging';
import { t } from '@/lib/i18n';
import { BackupFormatError, normalizeBackup, type Backup, type NormalizeWarnings } from '@/lib/schema';
import type { BrowserInfo } from '@/lib/browser-detect';
import type { LastRun, ScheduleFrequency, ScheduleSettings, SnapshotMeta } from '@/lib/types';
import {
  CONFIRM_RESET_MS,
  cx,
  dateTimeFormat,
  errorDetail,
  fmt,
  formatDate,
  formatSize,
  KEEP_MAX,
  KEEP_MIN,
  TONE,
  type Message,
} from '../shared';
import { CheckboxSimple, Hint, Panel, PanelIntro, Stat } from './ui';

const REASON_BADGE_KEYS: Record<string, string> = {
  scheduled: 'reasonScheduled',
  manual: 'reasonManual',
  'pre-replace': 'reasonPreReplace',
  'pre-import': 'reasonPreImport',
};
const SAFETY_REASONS = new Set(['pre-replace', 'pre-import']);

interface Form {
  enabled: boolean;
  frequency: ScheduleFrequency;
  keep: string;
  includeBookmarks: boolean;
}
const DEFAULT_FORM: Form = { enabled: false, frequency: 'daily', keep: '7', includeBookmarks: true };

const toForm = (settings: Partial<ScheduleSettings>): Form => ({
  enabled: settings.enabled === true,
  frequency: settings.frequency ?? 'daily',
  keep: String(settings.keep ?? 7),
  includeBookmarks: settings.includeBookmarks !== false,
});

function describeLastRun(lastRun: LastRun | null | undefined): Message {
  const date = formatDate(lastRun?.at, dateTimeFormat);
  if (!lastRun || !date) return { text: t('lastRunNever') };
  if (!lastRun.ok) return { text: t('lastRunFailed', lastRun.error || t('errorUnknown')), tone: TONE.error };
  if (lastRun.skipped) return { text: t('lastRunSkipped', date) };
  return { text: t('lastRunOk', date), tone: TONE.success };
}

interface Props {
  active: boolean;
  browser: BrowserInfo;
  restoreRunning: boolean;
  /** A snapshot was loaded and should be offered in the Import tab. */
  onRestore: (args: { data: Backup; warnings: NormalizeWarnings; date: string }) => void;
}

export function BackupsPanel({ active, browser, restoreRunning, onRestore }: Props) {
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  const dirty = useRef(false);
  const [lastRun, setLastRun] = useState<Message>({ text: '' });
  const [settingsMsg, setSettingsMsg] = useState<Message | null>(null);
  const [actionMsg, setActionMsg] = useState<Message | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [saving, setSaving] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const keepInput = useRef<HTMLInputElement>(null);
  const noAlarms = browser.features?.alarms === false;

  const refresh = useCallback(async () => {
    const response = await send('SNAPSHOTS_LIST');
    if (!response.ok) {
      setActionMsg({ text: t('snapshotsLoadFailed', errorDetail(response)), tone: TONE.error });
      return;
    }
    if (!dirty.current && response.settings) setForm(toForm(response.settings)); // Never overwrite edits in progress.
    setLastRun(describeLastRun(response.lastRun));
    setSnapshots(response.snapshots ?? []);
  }, []);

  // Snapshots live in the background: fetch them whenever the tab is shown.
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const edit = (patch: Partial<Form>) => {
    dirty.current = true;
    setForm((current) => ({ ...current, ...patch }));
  };

  async function saveSchedule() {
    const keep = Number(form.keep);
    if (!Number.isInteger(keep) || keep < KEEP_MIN || keep > KEEP_MAX) {
      setSettingsMsg({ text: t('autoKeepInvalid', [fmt(KEEP_MIN), fmt(KEEP_MAX)]), tone: TONE.error });
      keepInput.current?.focus();
      return;
    }
    setSaving(true);
    const response = await send('SCHEDULE_SET', {
      settings: { enabled: form.enabled, frequency: form.frequency, keep, includeBookmarks: form.includeBookmarks },
    });
    setSaving(false);
    if (response.ok) {
      dirty.current = false;
      setForm(toForm(response.settings));
      setSettingsMsg({ text: t('autoSaved'), tone: TONE.success });
    } else {
      setSettingsMsg({ text: t('autoSaveFailed', errorDetail(response)), tone: TONE.error });
    }
  }

  async function backupNow() {
    if (backingUp) return;
    setBackingUp(true);
    setActionMsg({ text: t('backupNowWorking') });
    const response = await send('SNAPSHOT_CREATE');
    setBackingUp(false);
    if (response.ok) {
      setActionMsg({ text: t('backupNowDone'), tone: TONE.success });
      void refresh();
    } else {
      setActionMsg({ text: t('backupNowFailed', errorDetail(response)), tone: TONE.error });
    }
  }

  async function restoreSnapshot(meta: SnapshotMeta, date: string) {
    if (restoreRunning) {
      setActionMsg({ text: t('importBusy'), tone: TONE.warning });
      return;
    }
    const response = await send('SNAPSHOT_GET', { id: meta.id });
    if (!response.ok) {
      setActionMsg({ text: t('snapshotLoadFailed', errorDetail(response)), tone: TONE.error });
      return;
    }
    let normalized: ReturnType<typeof normalizeBackup>;
    try {
      normalized = normalizeBackup(response.data);
    } catch (error) {
      const detail = error instanceof BackupFormatError ? error.message : t('errorUnknown');
      setActionMsg({ text: t('snapshotLoadFailed', detail), tone: TONE.error });
      return;
    }
    setActionMsg(null);
    onRestore({ data: normalized.data, warnings: normalized.warnings, date });
  }

  async function downloadSnapshot(meta: SnapshotMeta) {
    const response = await send('SNAPSHOT_DOWNLOAD', { id: meta.id });
    if (response.ok) setActionMsg({ text: t('snapshotDownloaded'), tone: TONE.success });
    else if (response.cancelled) setActionMsg({ text: t('snapshotDownloadCancelled') });
    else setActionMsg({ text: t('snapshotDownloadFailed', errorDetail(response)), tone: TONE.error });
  }

  async function deleteSnapshot(meta: SnapshotMeta) {
    const response = await send('SNAPSHOT_DELETE', { id: meta.id });
    if (response.ok) {
      setActionMsg({ text: t('snapshotDeleted'), tone: TONE.success });
      void refresh();
    } else {
      setActionMsg({ text: t('snapshotDeleteFailed', errorDetail(response)), tone: TONE.error });
    }
  }

  return (
    <Panel name="backups" active={active}>
      <PanelIntro title={t('backupsTitle')} text={t('backupsIntro')} />

      <div className="card">
        <h3 className="section-label">{t('autoTitle')}</h3>
        <div className="check-list">
          <CheckboxSimple id="bk-enabled" checked={form.enabled} disabled={noAlarms} onChange={(enabled) => edit({ enabled })}>
            {t('autoEnable')}
          </CheckboxSimple>
        </div>
        <div className="form-grid">
          <div className="form-row">
            <label htmlFor="bk-frequency">{t('autoFrequencyLabel')}</label>
            <select
              id="bk-frequency"
              value={form.frequency}
              disabled={noAlarms}
              onChange={(event) => edit({ frequency: event.target.value as ScheduleFrequency })}
            >
              <option value="hourly">{t('freqHourly')}</option>
              <option value="daily">{t('freqDaily')}</option>
              <option value="weekly">{t('freqWeekly')}</option>
            </select>
          </div>
          <div className="form-row">
            <label htmlFor="bk-keep">{t('autoKeepLabel')}</label>
            <input
              ref={keepInput}
              type="number"
              id="bk-keep"
              min={KEEP_MIN}
              max={KEEP_MAX}
              step={1}
              inputMode="numeric"
              aria-describedby="bk-keep-hint"
              value={form.keep}
              disabled={noAlarms}
              onChange={(event) => edit({ keep: event.target.value })}
            />
          </div>
        </div>
        <p className="field-hint" id="bk-keep-hint">
          {t('autoKeepHint', [fmt(KEEP_MIN), fmt(KEEP_MAX)])}
        </p>
        <div className="check-list spaced">
          <CheckboxSimple id="bk-bookmarks" checked={form.includeBookmarks} disabled={noAlarms} onChange={(includeBookmarks) => edit({ includeBookmarks })}>
            {t('autoIncludeBookmarks')}
          </CheckboxSimple>
        </div>
        <Hint id="bk-unavailable" tone={TONE.warning} live={false} text={noAlarms ? t('autoUnavailable') : null} />
        <Hint id="bk-last-run" text={lastRun.text} tone={lastRun.tone} />
        <Hint id="bk-settings-msg" text={settingsMsg?.text} tone={settingsMsg?.tone} />
        <div className="button-row">
          <button type="button" id="btn-save-schedule" className="btn-secondary" disabled={noAlarms || saving} onClick={saveSchedule}>
            {t('autoSave')}
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3 className="section-label">{t('snapshotsTitle')}</h3>
        </div>
        <button type="button" id="btn-backup-now" className="btn-primary" disabled={backingUp} onClick={backupNow}>
          {t('backupNow')}
        </button>
        <Hint id="bk-action-msg" text={actionMsg?.text} tone={actionMsg?.tone} />
        <ul id="snapshot-list" className="snapshot-list">
          {snapshots.map((meta) => (
            <SnapshotItem
              key={meta.id}
              meta={meta}
              onRestore={(date) => void restoreSnapshot(meta, date)}
              onDownload={() => void downloadSnapshot(meta)}
              onDelete={() => void deleteSnapshot(meta)}
            />
          ))}
        </ul>
        <p id="snapshots-empty" className={cx('empty-state', snapshots.length > 0 && 'hidden')}>
          {t('snapshotsEmpty')}
        </p>
        <p className="field-hint">{t('snapshotsNote')}</p>
      </div>
    </Panel>
  );
}

function SnapshotItem({
  meta,
  onRestore,
  onDownload,
  onDelete,
}: {
  meta: SnapshotMeta;
  onRestore: (date: string) => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const date = formatDate(meta.createdAt, dateTimeFormat) ?? '';
  const badgeKey = REASON_BADGE_KEYS[meta.reason];
  const size = formatSize(meta.bytes);

  // Delete needs a second click on the same button within a few seconds.
  const [armed, setArmed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarm = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setArmed(false);
  };
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const onDeleteClick = () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(disarm, CONFIRM_RESET_MS);
      return;
    }
    disarm();
    onDelete();
  };

  return (
    <li className="snapshot">
      <div className="snapshot-head">
        <span className="snapshot-date">{date}</span>
        <span className={cx('badge', SAFETY_REASONS.has(meta.reason) && 'is-safety')}>{badgeKey ? t(badgeKey) : String(meta.reason ?? '')}</span>
      </div>
      <div className="snapshot-meta">
        <Stat value={meta.stats?.tabs ?? 0} label={t('labelTabs')} />
        <Stat value={meta.stats?.bookmarks ?? 0} label={t('labelBookmarks')} />
        {size && <span className="snapshot-size">{size}</span>}
      </div>
      <div className="snapshot-actions">
        <button type="button" className="btn-small" aria-label={t('snapshotRestoreLabel', date)} onClick={() => onRestore(date)}>
          {t('snapshotRestore')}
        </button>
        <button type="button" className="btn-small" aria-label={t('snapshotDownloadLabel', date)} onClick={onDownload}>
          {t('snapshotDownload')}
        </button>
        <button
          type="button"
          className={cx('btn-small', 'is-danger', armed && 'is-confirm')}
          aria-label={armed ? t('snapshotConfirmDeleteLabel', date) : t('snapshotDeleteLabel', date)}
          onClick={onDeleteClick}
          onBlur={() => armed && disarm()}
        >
          {armed ? t('snapshotConfirmDelete') : t('snapshotDelete')}
        </button>
      </div>
    </li>
  );
}
