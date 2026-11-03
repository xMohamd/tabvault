/**
 * Backups tab: the snapshot list first (the common task), automatic-backup
 * settings in a collapsed section that saves as you change it, and
 * "Back up now" pinned at the bottom.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArchiveIcon, DownloadIcon, HistoryIcon, Trash2Icon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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

const REASON_BADGE_KEYS: Record<string, string> = {
  scheduled: 'reasonScheduled',
  manual: 'reasonManual',
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
}
const DEFAULT_FORM: Form = { enabled: false, frequency: 'daily', keep: '7', includeBookmarks: true };

const toForm = (settings: Partial<ScheduleSettings>): Form => ({
  enabled: settings.enabled === true,
  frequency: settings.frequency ?? 'daily',
  keep: String(settings.keep ?? 7),
  includeBookmarks: settings.includeBookmarks !== false,
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
      settings: { enabled: next.enabled, frequency: next.frequency, keep, includeBookmarks: next.includeBookmarks },
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

  const count = snapshots?.length ?? 0;
  const keepSummary = parseKeep(form.keep) ?? Number(saved.current.keep);

  return (
    <div id="backups-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
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
          </div>

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
                className="w-20! flex-none" /* ! beats the legacy unlayered input[type=number] rule in popup.css */
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
          </FieldGroup>
          {noAlarms && (
            <p id="bk-unavailable" className="text-sm text-warning">
              {t('autoUnavailable')}
            </p>
          )}
          <p id="bk-last-run" role="status" className={cn('text-xs text-muted-foreground', lastRun.tone === TONE.error && 'text-destructive')}>
            {lastRun.text}
          </p>
        </SettingsSection>
      </div>

      <div className="flex flex-col gap-2 border-t bg-background px-4 py-3">
        {count > 0 && <p className="text-center text-xs text-muted-foreground">{t('snapshotsNote')}</p>}
        <Button id="btn-backup-now" size="lg" className="w-full" disabled={backingUp} onClick={() => void backupNow()}>
          {backingUp ? <Spinner data-icon="inline-start" /> : <HistoryIcon data-icon="inline-start" />}
          {backingUp ? t('backupNowWorking') : t('backupNow')}
        </Button>
      </div>
    </div>
  );
}

function SnapshotRow({
  meta,
  restoreDisabled,
  onRestore,
  onDownload,
  onDelete,
}: {
  meta: SnapshotMeta;
  restoreDisabled: boolean;
  onRestore: (date: string) => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const date = formatDate(meta.createdAt, dateTimeFormat) ?? '';
  const badgeKey = REASON_BADGE_KEYS[meta.reason];
  const size = formatSize(meta.bytes);
  const tabs = meta.stats?.tabs ?? 0;
  const bookmarks = meta.stats?.bookmarks ?? 0;
  const details = [`${fmt(tabs)} ${t('labelTabs').toLowerCase()}`, `${fmt(bookmarks)} ${t('labelBookmarks').toLowerCase()}`, size].filter(Boolean).join(' · ');

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
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            <span className="truncate">{date}</span>
            <Badge variant={SAFETY_REASONS.has(meta.reason) ? 'outline' : 'secondary'} className="font-normal">
              {badgeKey ? t(badgeKey) : String(meta.reason ?? '')}
            </Badge>
          </ItemTitle>
          <ItemDescription className="text-xs tabular-nums">{details}</ItemDescription>
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
