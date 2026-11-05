/**
 * Backups tab: the snapshot list first (the common task), automatic-backup
 * settings in a collapsed section that saves as you change it, and
 * "Back up now" pinned at the bottom.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveIcon, DownloadIcon, FileCheckIcon, GitCompareIcon, HistoryIcon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { send } from '@/lib/messaging';
import { t } from '@/lib/i18n';
import { BackupFormatError, normalizeBackup, type Backup, type NormalizeWarnings } from '@/lib/schema';
import { diffBackups, type BackupDiff } from '@/lib/snapshot-diff';
import type { BrowserInfo } from '@/lib/browser-detect';
import type { LastRun, ScheduleFrequency, ScheduleSettings, SnapshotMeta } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  CONFIRM_RESET_MS,
  dateTimeFormat,
  errorDetail,
  fmt,
  formatDate,
  formatSize,
  KEEP_MAX,
  KEEP_MIN,
  TONE,
  type Message,
  type SetStatus,
} from '../shared';
import { SettingsSection, SwitchRow } from './settings';
import { SnapshotCompare } from './SnapshotCompare';

const REASON_BADGE_KEYS: Record<string, string> = {
  scheduled: 'reasonScheduled',
  manual: 'reasonManual',
  quick: 'reasonQuick',
  'pre-replace': 'reasonPreReplace',
  'pre-import': 'reasonPreImport',
};
const SAFETY_REASONS = new Set(['pre-replace', 'pre-import']);
const FREQUENCY_KEYS: Record<ScheduleFrequency, string> = {
  hourly: 'freqHourlyShort',
  daily: 'freqDailyShort',
  weekly: 'freqWeeklyShort',
};
const FREQUENCIES = Object.keys(FREQUENCY_KEYS) as ScheduleFrequency[];

interface Form {
  enabled: boolean;
  frequency: ScheduleFrequency;
  keep: string;
  includeBookmarks: boolean;
  saveToFiles: boolean;
}
const DEFAULT_FORM: Form = { enabled: false, frequency: 'daily', keep: '7', includeBookmarks: true, saveToFiles: false };

const toForm = (settings: Partial<ScheduleSettings>): Form => ({
  enabled: settings.enabled === true,
  frequency: settings.frequency ?? 'daily',
  keep: String(settings.keep ?? 7),
  includeBookmarks: settings.includeBookmarks !== false,
  saveToFiles: settings.saveToFiles === true,
});

/** The whole number the field holds, or null when it is not a valid keep count. */
function parseKeep(value: string): number | null {
  const keep = Number(value);
  return value.trim() !== '' && Number.isInteger(keep) && keep >= KEEP_MIN && keep <= KEEP_MAX ? keep : null;
}

function describeLastRun(lastRun: LastRun | null | undefined): Message {
  const date = formatDate(lastRun?.at, dateTimeFormat);
  if (!lastRun || !date) return { text: t('lastRunNever') };
  if (!lastRun.ok) return { text: t('lastRunFailed', lastRun.error || t('errorUnknown')), tone: TONE.error };
  if (lastRun.skipped) return { text: t('lastRunSkipped', date) };
  // The backup was kept but its file could not be written.
  if (lastRun.error) return { text: t('lastRunFileWarning', [date, lastRun.error]), tone: TONE.warning };
  return { text: t('lastRunOk', date), tone: TONE.success };
}

interface Props {
  active: boolean;
  browser: BrowserInfo;
  restoreRunning: boolean;
  setStatus: SetStatus;
  /** A snapshot was loaded and should be offered in the Import tab. */
  onRestore: (args: { data: Backup; warnings: NormalizeWarnings; date: string }) => void;
}

export function BackupsPanel({ active, browser, restoreRunning, setStatus, onRestore }: Props) {
  const [form, setForm] = useState<Form>(DEFAULT_FORM);
  /** The settings the background last confirmed. */
  const saved = useRef<Form>(DEFAULT_FORM);
  /** The keep field holds typing that has not been saved yet. */
  const keepDirty = useRef(false);
  const [lastRun, setLastRun] = useState<Message>({ text: '' });
  const [keepError, setKeepError] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [backingUp, setBackingUp] = useState(false);
  /** Compare mode: rows get checkboxes; two selected snapshots can be compared. */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [comparison, setComparison] = useState<{ from: string; to: string; diff: BackupDiff } | null>(null);
  const noAlarms = browser.features?.alarms === false;

  const applySettings = useCallback((settings: Partial<ScheduleSettings>) => {
    const next = toForm(settings);
    saved.current = next;
    // Never overwrite typing in progress.
    setForm((current) => ({ ...next, keep: keepDirty.current ? current.keep : next.keep }));
  }, []);

  const refresh = useCallback(async () => {
    const response = await send('SNAPSHOTS_LIST');
    if (!response.ok) {
      setSnapshots((current) => current ?? []);
      setStatus(t('snapshotsLoadFailed', errorDetail(response)), TONE.error);
      return;
    }
    if (response.settings) applySettings(response.settings);
    setLastRun(describeLastRun(response.lastRun));
    setSnapshots(response.snapshots ?? []);
  }, [applySettings, setStatus]);

  // Snapshots live in the background: fetch them whenever the tab is shown.
  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  /** Sends the settings; the background's answer becomes the new state. */
  async function save(next: Form) {
    const keep = parseKeep(next.keep);
    if (keep === null) return;
    const response = await send('SCHEDULE_SET', {
      settings: {
        enabled: next.enabled,
        frequency: next.frequency,
        keep,
        includeBookmarks: next.includeBookmarks,
        saveToFiles: next.saveToFiles,
      },
    });
    if (response.ok) {
      applySettings(response.settings);
      setStatus(t('autoSaved'), TONE.success);
    } else {
      setForm((current) => ({ ...saved.current, keep: keepDirty.current ? current.keep : saved.current.keep }));
      setStatus(t('autoSaveFailed', errorDetail(response)), TONE.error);
    }
  }

  /** Switches and frequency save at once; a half-typed keep count is not sent. */
  function change(patch: Partial<Form>) {
    const next = { ...form, ...patch };
    setForm(next);
    void save({ ...next, keep: parseKeep(next.keep) === null ? saved.current.keep : next.keep });
  }

  function editKeep(value: string) {
    keepDirty.current = true;
    setForm((current) => ({ ...current, keep: value }));
    if (parseKeep(value) !== null) setKeepError(null);
  }

  /** Blur / Enter: save a valid count, flag an invalid one. */
  function commitKeep() {
    if (!keepDirty.current) return;
    if (parseKeep(form.keep) === null) {
      setKeepError(t('autoKeepInvalid', [fmt(KEEP_MIN), fmt(KEEP_MAX)]));
      return;
    }
    keepDirty.current = false;
    setKeepError(null);
    if (form.keep !== saved.current.keep) void save(form);
  }

  async function backupNow() {
    if (backingUp) return;
    setBackingUp(true);
    const response = await send('SNAPSHOT_CREATE');
    setBackingUp(false);
    if (response.ok) {
      setStatus(t('backupNowDone'), TONE.success);
      void refresh();
    } else {
      setStatus(t('backupNowFailed', errorDetail(response)), TONE.error);
    }
  }

  async function restoreSnapshot(meta: SnapshotMeta, date: string) {
    if (restoreRunning) {
      setStatus(t('importBusy'), TONE.warning);
      return;
    }
    const response = await send('SNAPSHOT_GET', { id: meta.id });
    if (!response.ok) {
      setStatus(t('snapshotLoadFailed', errorDetail(response)), TONE.error);
      return;
    }
    let normalized: ReturnType<typeof normalizeBackup>;
    try {
      normalized = normalizeBackup(response.data);
    } catch (error) {
      const detail = error instanceof BackupFormatError ? error.message : t('errorUnknown');
      setStatus(t('snapshotLoadFailed', detail), TONE.error);
      return;
    }
    onRestore({ data: normalized.data, warnings: normalized.warnings, date });
  }

  async function downloadSnapshot(meta: SnapshotMeta) {
    const response = await send('SNAPSHOT_DOWNLOAD', { id: meta.id });
    if (response.ok) setStatus(t('snapshotDownloaded'), TONE.success);
    else if (response.cancelled) setStatus(t('snapshotDownloadCancelled'));
    else setStatus(t('snapshotDownloadFailed', errorDetail(response)), TONE.error);
  }

  async function deleteSnapshot(meta: SnapshotMeta) {
    const response = await send('SNAPSHOT_DELETE', { id: meta.id });
    if (response.ok) {
      setStatus(t('snapshotDeleted'), TONE.success);
      void refresh();
    } else {
      setStatus(t('snapshotDeleteFailed', errorDetail(response)), TONE.error);
    }
  }

  function stopSelecting() {
    setSelecting(false);
    setSelected([]);
  }

  function toggleSelected(id: string, checked: boolean) {
    setSelected((current) => (checked ? (current.includes(id) || current.length >= 2 ? current : [...current, id]) : current.filter((x) => x !== id)));
  }

  /** Loads both snapshots and diffs them, always older → newer whatever the selection order. */
  async function compareSelected() {
    const metas = (snapshots ?? []).filter((m) => selected.includes(m.id));
    const [older, newer] = metas.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    if (!older || !newer || comparing) return;
    setComparing(true);
    const [first, second] = await Promise.all([send('SNAPSHOT_GET', { id: older.id }), send('SNAPSHOT_GET', { id: newer.id })]);
    setComparing(false);
    if (!first.ok || !second.ok) {
      setStatus(t('compareLoadFailed', errorDetail(first.ok ? second : first)), TONE.error);
      return;
    }
    setComparison({
      from: formatDate(older.createdAt, dateTimeFormat) ?? '',
      to: formatDate(newer.createdAt, dateTimeFormat) ?? '',
      diff: diffBackups(first.data, second.data),
    });
  }

  function closeComparison() {
    setComparison(null);
    stopSelecting();
  }

  const count = snapshots?.length ?? 0;
  const keepSummary = parseKeep(form.keep) ?? Number(saved.current.keep);

  return (
    <div id="backups-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-2 pb-4">
        {comparison ? (
          <SnapshotCompare from={comparison.from} to={comparison.to} diff={comparison.diff} onBack={closeComparison} />
        ) : (
        <>
        <section aria-labelledby="snapshots-heading" className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 id="snapshots-heading" className="text-sm font-medium">
              {t('snapshotsTitle')}
            </h2>
            {snapshots !== null && count > 0 && (
              <Badge id="snapshot-count" variant="secondary" className="tabular-nums">
                {fmt(count)}
              </Badge>
            )}
            {count >= 2 && (
              <div className="ml-auto flex items-center gap-1">
                {selecting ? (
                  <>
                    <Button id="btn-compare-run" size="sm" disabled={selected.length !== 2 || comparing} onClick={() => void compareSelected()}>
                      {comparing && <Spinner data-icon="inline-start" />}
                      {t('compareRun')}
                    </Button>
                    <Button id="btn-compare-cancel" variant="ghost" size="sm" onClick={stopSelecting}>
                      {t('compareCancel')}
                    </Button>
                  </>
                ) : (
                  <Button id="btn-compare" variant="ghost" size="sm" onClick={() => setSelecting(true)}>
                    <GitCompareIcon data-icon="inline-start" />
                    {t('compareStart')}
                  </Button>
                )}
              </div>
            )}
          </div>
          {selecting && <p className="text-xs text-muted-foreground">{t('compareHint')}</p>}

          {snapshots === null ? (
            <div className="flex flex-col gap-2" aria-busy="true">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : count === 0 ? (
            <Empty id="snapshots-empty" className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ArchiveIcon />
                </EmptyMedia>
                <EmptyTitle>{t('snapshotsEmptyTitle')}</EmptyTitle>
                <EmptyDescription>{t('snapshotsEmpty')}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <p className="text-xs text-muted-foreground">{t('snapshotsNote')}</p>
              </EmptyContent>
            </Empty>
          ) : (
            <ul id="snapshot-list" className="flex flex-col gap-2">
              {snapshots.map((meta) => (
                <SnapshotRow
                  key={meta.id}
                  meta={meta}
                  restoreDisabled={restoreRunning}
                  selecting={selecting}
                  checked={selected.includes(meta.id)}
                  selectDisabled={!selected.includes(meta.id) && selected.length >= 2}
                  onSelect={(checked) => toggleSelected(meta.id, checked)}
                  onRestore={(date) => void restoreSnapshot(meta, date)}
                  onDownload={() => void downloadSnapshot(meta)}
                  onDelete={() => void deleteSnapshot(meta)}
                />
              ))}
            </ul>
          )}
        </section>

        <SettingsSection
          id="backups-auto"
          title={t('autoTitle')}
          summary={form.enabled ? t('autoSummaryOn', [t(FREQUENCY_KEYS[form.frequency]), fmt(keepSummary)]) : t('autoSummaryOff')}
        >
          <FieldGroup className="gap-4">
            <SwitchRow id="bk-enabled" label={t('autoEnable')} checked={form.enabled} disabled={noAlarms} onChange={(enabled) => change({ enabled })} />
            <Field>
              <FieldLabel id="bk-frequency-label">{t('autoFrequencyLabel')}</FieldLabel>
              <ToggleGroup
                id="bk-frequency"
                type="single"
                variant="outline"
                spacing={0}
                aria-labelledby="bk-frequency-label"
                className="w-full"
                value={form.frequency}
                disabled={noAlarms}
                // Radix reports '' when the active item is clicked again; a frequency is always required.
                onValueChange={(value) => value && change({ frequency: value as ScheduleFrequency })}
              >
                {FREQUENCIES.map((frequency) => (
                  <ToggleGroupItem key={frequency} value={frequency} className="flex-1">
                    {t(FREQUENCY_KEYS[frequency])}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
            <Field orientation="horizontal" data-invalid={keepError ? true : undefined}>
              <FieldContent>
                <FieldLabel htmlFor="bk-keep">{t('autoKeepLabel')}</FieldLabel>
                <FieldDescription id="bk-keep-hint">{t('autoKeepHint', [fmt(KEEP_MIN), fmt(KEEP_MAX)])}</FieldDescription>
                {keepError && <FieldError id="bk-settings-msg">{keepError}</FieldError>}
              </FieldContent>
              <Input
                type="number"
                id="bk-keep"
                className="w-20 flex-none"
                min={KEEP_MIN}
                max={KEEP_MAX}
                step={1}
                inputMode="numeric"
                aria-invalid={keepError ? true : undefined}
                aria-describedby={keepError ? 'bk-keep-hint bk-settings-msg' : 'bk-keep-hint'}
                value={form.keep}
                disabled={noAlarms}
                onChange={(event) => editKeep(event.target.value)}
                onBlur={commitKeep}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitKeep();
                }}
              />
            </Field>
            <SwitchRow
              id="bk-bookmarks"
              label={t('autoIncludeBookmarks')}
              checked={form.includeBookmarks}
              disabled={noAlarms}
              onChange={(includeBookmarks) => change({ includeBookmarks })}
            />
            <SwitchRow
              id="bk-files"
              label={t('autoSaveFiles')}
              description={t('autoSaveFilesHint', fmt(keepSummary))}
              checked={form.saveToFiles}
              disabled={noAlarms}
              onChange={(saveToFiles) => change({ saveToFiles })}
            />
          </FieldGroup>
          {noAlarms && (
            <p id="bk-unavailable" className="text-sm text-warning">
              {t('autoUnavailable')}
            </p>
          )}
          <p id="bk-last-run" role="status" className={cn('text-xs text-muted-foreground', lastRun.tone === TONE.error && 'text-destructive', lastRun.tone === TONE.warning && 'text-warning')}>
            {lastRun.text}
          </p>
        </SettingsSection>
        </>
        )}
      </div>

      {!comparison && (
        <div className="flex flex-col gap-2 border-t bg-background px-4 py-3">
          {count > 0 && <p className="text-center text-xs text-muted-foreground">{t('snapshotsNote')}</p>}
          <Button id="btn-backup-now" size="lg" className="w-full" disabled={backingUp} onClick={() => void backupNow()}>
            {backingUp ? <Spinner data-icon="inline-start" /> : <HistoryIcon data-icon="inline-start" />}
            {backingUp ? t('backupNowWorking') : t('backupNow')}
          </Button>
        </div>
      )}
    </div>
  );
}

function SnapshotRow({
  meta,
  restoreDisabled,
  selecting,
  checked,
  selectDisabled,
  onSelect,
  onRestore,
  onDownload,
  onDelete,
}: {
  meta: SnapshotMeta;
  restoreDisabled: boolean;
  selecting: boolean;
  checked: boolean;
  selectDisabled: boolean;
  onSelect: (checked: boolean) => void;
  onRestore: (date: string) => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const date = formatDate(meta.createdAt, dateTimeFormat) ?? '';
  const badgeKey = REASON_BADGE_KEYS[meta.reason];
  const size = formatSize(meta.bytes);
  const tabs = meta.stats?.tabs ?? 0;
  const bookmarks = meta.stats?.bookmarks ?? 0;
  const details = [meta.scope?.title, `${fmt(tabs)} ${t('labelTabs').toLowerCase()}`, `${fmt(bookmarks)} ${t('labelBookmarks').toLowerCase()}`, size].filter(Boolean).join(' · ');

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
    <li>
      <Item variant="outline" size="sm" className="flex-nowrap">
        {selecting && (
          <Checkbox
            checked={checked}
            disabled={selectDisabled}
            aria-label={t('compareSelectLabel', date)}
            onCheckedChange={(value) => onSelect(value === true)}
          />
        )}
        <ItemContent className="min-w-0">
          {/* Date alone on the first line so it never truncates; reason + counts below. */}
          <ItemTitle className="w-full">
            <span className="truncate">{date}</span>
            {meta.file && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span role="img" tabIndex={0} aria-label={t('snapshotFileSaved', meta.file.filename)} className="text-muted-foreground">
                    <FileCheckIcon className="size-3.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{meta.file.filename}</TooltipContent>
              </Tooltip>
            )}
          </ItemTitle>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
            <Badge variant={SAFETY_REASONS.has(meta.reason) ? 'outline' : 'secondary'} className="font-normal">
              {badgeKey ? t(badgeKey) : String(meta.reason ?? '')}
            </Badge>
            <ItemDescription className="max-w-full shrink-0 text-xs tabular-nums">{details}</ItemDescription>
          </div>
        </ItemContent>
        <ItemActions>
          <Button variant="outline" size="sm" aria-label={t('snapshotRestoreLabel', date)} disabled={restoreDisabled} onClick={() => onRestore(date)}>
            {t('snapshotRestore')}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={t('snapshotDownloadLabel', date)} onClick={onDownload}>
                <DownloadIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('snapshotDownload')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={armed ? 'destructive' : 'ghost'}
                size={armed ? 'sm' : 'icon-sm'}
                aria-label={armed ? t('snapshotConfirmDeleteLabel', date) : t('snapshotDeleteLabel', date)}
                onClick={onDeleteClick}
                onBlur={() => armed && disarm()}
              >
                {armed ? t('snapshotConfirmDelete') : <Trash2Icon />}
              </Button>
            </TooltipTrigger>
            {!armed && <TooltipContent>{t('snapshotDelete')}</TooltipContent>}
          </Tooltip>
        </ItemActions>
      </Item>
    </li>
  );
}
