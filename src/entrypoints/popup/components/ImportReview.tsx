/**
 * Review step of the Import tab: what the loaded backup contains, what to restore,
 * the restore options, and the main action pinned at the bottom.
 * Keyed by candidate id, so a new backup starts with fresh selections.
 */
import { useState } from 'react';
import { ArchiveRestoreIcon, InfoIcon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet } from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { send } from '@/lib/messaging';
import { t, tp } from '@/lib/i18n';
import { countBookmarklets, countBookmarks, countGroups, countTabs } from '@/lib/schema';
import type { BrowserInfo } from '@/lib/browser-detect';
import type { BookmarkStrategy, ImportOptions, RestoreMode } from '@/lib/types';
import { errorDetail, fmt, formatDate, MANY_TABS_THRESHOLD, TONE, type SetStatus } from '../shared';
import type { Candidate, ImportCandidateApi } from '../hooks/useImportCandidate';
import { defaultSelection, PreviewCard, selectedData, selectedTabCount, type WindowSelection } from './PreviewTree';
import { useFocusOnMount } from './ImportProgress';
import { SettingsSection, SwitchRow } from './settings';
import { ToneAlert } from './ToneAlert';


/** Options that survive loading another backup. */
export interface RestoreSettings {
  restoreMode: RestoreMode;
  skipOpen: boolean;
  skipBlank: boolean;
  restoreLayout: boolean;
  bmStrategy: BookmarkStrategy;
  skipDupes: boolean;
}
export const DEFAULT_SETTINGS: RestoreSettings = {
  restoreMode: 'discard',
  skipOpen: true,
  skipBlank: true,
  restoreLayout: true,
  bmStrategy: 'merge',
  skipDupes: true,
};

const LOAD_MODES: Array<[RestoreMode, string]> = [
  ['discard', 'loadDiscard'],
  ['lazy', 'loadLazy'],
  ['load', 'loadLoad'],
];
const BOOKMARK_STRATEGIES: Array<[BookmarkStrategy, string]> = [
  ['merge', 'bmMerge'],
  ['folder', 'bmFolder'],
  ['replace', 'bmReplace'],
];

function StatCell({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-lg font-semibold tabular-nums">{fmt(value)}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

/** The button says exactly what will happen. */
function buttonLabel(tabs: number, bookmarks: boolean): string {
  if (tabs > 0 && bookmarks) return t('importButtonBoth');
  if (tabs > 0) return tp('importButtonTabs', tabs, fmt(tabs));
  if (bookmarks) return t('importButtonBookmarks');
  return t('importStart');
}

interface Props {
  candidate: Candidate;
  browser: BrowserInfo;
  running: boolean;
  settings: RestoreSettings;
  setSettings: (next: RestoreSettings) => void;
  fileInfo: ImportCandidateApi['fileInfo'];
  importMessage: ImportCandidateApi['importMessage'];
  setImportMessage: ImportCandidateApi['setImportMessage'];
  setStatus: SetStatus;
  onChooseFile: () => void;
  onStartAccepted: () => void;
}

export function ImportReview(props: Props) {
  const { candidate, browser, running, settings, fileInfo, importMessage, setImportMessage, setStatus } = props;
  const { data, hasTabs, hasBookmarks } = candidate;
  const [selection, setSelection] = useState<WindowSelection[]>(() => defaultSelection(data));
  const bookmarksSupported = browser.features?.bookmarks !== false;
  const [importTabs, setImportTabs] = useState(hasTabs);
  const [importBookmarks, setImportBookmarks] = useState(hasBookmarks && bookmarksSupported);
  const bookmarkletCount = countBookmarklets(data.bookmarks);
  const [importBookmarklets, setImportBookmarklets] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const focusOnMount = useFocusOnMount();

  const tabsOn = hasTabs && importTabs;
  const bookmarksOn = hasBookmarks && bookmarksSupported && importBookmarks;
  const selectedTabs = selectedTabCount(data, selection);
  const restoringTabs = tabsOn ? selectedTabs : 0;
  const replacing = settings.bmStrategy === 'replace';
  const many = tabsOn && selectedTabs > MANY_TABS_THRESHOLD;
  const nothingToRestore = !((tabsOn && selectedTabs > 0) || bookmarksOn);
  const startDisabled = running || starting || nothingToRestore;

  const patch = (next: Partial<RestoreSettings>) => props.setSettings({ ...settings, ...next });

  const date = formatDate(data.exportedAt);
  const warnings = candidate.warnings;
  const invalid = (warnings?.invalidTabs ?? 0) + (warnings?.invalidWindows ?? 0) + (warnings?.invalidBookmarks ?? 0);
  const notes = [
    ...(invalid > 0 ? [tp('warnInvalidEntries', invalid, fmt(invalid))] : []),
    ...(warnings?.newerSchema ? [t('warnNewerSchema')] : []),
    ...(data.source?.truncated ? [t('warnTruncated')] : []),
    ...(bookmarkletCount > 0 && bookmarksSupported ? [tp('warnBookmarklets', bookmarkletCount, fmt(bookmarkletCount))] : []),
  ];

  function handleStartClick() {
    if (startDisabled) return;
    if (bookmarksOn && replacing) {
      setConfirming(true);
      return;
    }
    void startImport();
  }

  async function startImport() {
    const options: ImportOptions = {
      importTabs: tabsOn,
      importBookmarks: bookmarksOn,
      bookmarkStrategy: settings.bmStrategy,
      skipDuplicateBookmarks: settings.skipDupes && !replacing,
      importBookmarklets,
      restoreMode: settings.restoreMode,
      restoreWindowLayout: settings.restoreLayout,
      skipOpenTabs: settings.skipOpen,
      skipBlankTabs: settings.skipBlank,
      focusRestored: false,
    };
    setImportMessage(null);
    setStarting(true);
    const response = await send('IMPORT_START', { data: selectedData(data, selection), options });
    setStarting(false);
    if (!response.ok) {
      const message = t('importStartFailed', errorDetail(response));
      setImportMessage({ text: message, tone: TONE.error });
      setStatus(message, TONE.error);
      return;
    }
    props.onStartAccepted();
  }

  const loadModeLabel = t(LOAD_MODES.find(([value]) => value === settings.restoreMode)?.[1] ?? 'loadDiscard');
  const strategyLabel = t(BOOKMARK_STRATEGIES.find(([value]) => value === settings.bmStrategy)?.[1] ?? 'bmMerge');
  const noTabGroups = browser.features?.tabGroups === false;

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <section
          id="import-summary"
          ref={focusOnMount}
          tabIndex={-1}
          aria-label={t('summaryTitle')}
          className="flex flex-col gap-3 rounded-lg border bg-card px-3 py-3 outline-none!"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <p id="summary-format" className="text-sm font-medium">
                {t('summaryFormat', candidate.label)}
              </p>
              {date && (
                <p id="summary-date" className="text-xs text-muted-foreground">
                  {t('summaryDate', date)}
                </p>
              )}
              {fileInfo?.text && (
                <p id="file-info" role="status" className="truncate text-xs text-muted-foreground">
                  {fileInfo.text}
                </p>
              )}
            </div>
            <Button type="button" id="btn-choose-another" variant="link" size="xs" disabled={running} onClick={props.onChooseFile}>
              {t('importChooseAnother')}
            </Button>
          </div>
          <div id="summary-stats" className="grid grid-cols-4 gap-2">
            <StatCell value={countTabs(data)} label={t('labelTabs')} />
            <StatCell value={data.windows.length} label={t('labelWindows')} />
            <StatCell value={countGroups(data)} label={t('labelGroups')} />
            <StatCell value={countBookmarks(data.bookmarks)} label={t('labelBookmarks')} />
          </div>
        </section>

        {notes.length > 0 && (
          <div id="summary-warnings" className="flex flex-col gap-2">
            {notes.map((note) => (
              <ToneAlert key={note} role="note" tone={TONE.warning}>
                {note}
              </ToneAlert>
            ))}
          </div>
        )}

        {tabsOn && <PreviewCard data={data} selection={selection} onChange={setSelection} />}

        {(hasTabs || (hasBookmarks && bookmarksSupported)) && (
          <FieldSet id="import-options">
            <FieldLegend variant="label">{t('importWhatLabel')}</FieldLegend>
            <FieldGroup className="gap-4">
              {hasTabs && <SwitchRow id="im-tabs" label={t('importTabsOption')} checked={importTabs} onChange={setImportTabs} />}
              {hasTabs && hasBookmarks && bookmarksSupported && <FieldSeparator />}
              {hasBookmarks && bookmarksSupported && (
                <SwitchRow id="im-bookmarks" label={t('importBookmarksOption')} checked={importBookmarks} onChange={setImportBookmarks} />
              )}
              {bookmarkletCount > 0 && bookmarksSupported && (
                <SwitchRow
                  id="im-bookmarklets"
                  inset
                  label={tp('importBookmarkletsOption', bookmarkletCount, fmt(bookmarkletCount))}
                  checked={importBookmarklets}
                  disabled={!bookmarksOn}
                  onChange={setImportBookmarklets}
                />
              )}
            </FieldGroup>
          </FieldSet>
        )}

        {tabsOn && (
          <SettingsSection id="tab-options" title={t('importTabOptionsLabel')} summary={loadModeLabel}>
            <Field>
              <FieldLabel htmlFor="im-restore-mode">{t('importLoadingLabel')}</FieldLabel>
              <Select value={settings.restoreMode} onValueChange={(value) => patch({ restoreMode: value as RestoreMode })}>
                <SelectTrigger id="im-restore-mode" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {LOAD_MODES.map(([value, labelKey]) => (
                      <SelectItem key={value} value={value}>
                        {t(labelKey)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <SwitchRow id="im-skip-open" label={t('importSkipOpen')} checked={settings.skipOpen} onChange={(value) => patch({ skipOpen: value })} />
            <SwitchRow id="im-skip-blank" label={t('importSkipBlank')} checked={settings.skipBlank} onChange={(value) => patch({ skipBlank: value })} />
            <SwitchRow
              id="im-restore-layout"
              label={t('importRestoreLayout')}
              checked={settings.restoreLayout}
              onChange={(value) => patch({ restoreLayout: value })}
            />
            {noTabGroups && (
              <Alert id="im-no-groups-hint">
                <InfoIcon />
                <AlertDescription>{t('importNoTabGroups')}</AlertDescription>
              </Alert>
            )}
          </SettingsSection>
        )}

        {hasBookmarks && !bookmarksSupported && (
          <ToneAlert id="bm-unsupported" tone={TONE.warning}>
            {t('importNoBookmarksApi')}
          </ToneAlert>
        )}

        {hasBookmarks && bookmarksSupported && bookmarksOn && (
          <SettingsSection id="bookmark-options" title={t('importBookmarkOptionsLabel')} summary={strategyLabel}>
            <FieldSet id="bm-controls">
              <RadioGroup
                value={settings.bmStrategy}
                onValueChange={(value) => patch({ bmStrategy: value as BookmarkStrategy })}
                aria-label={t('importBookmarkOptionsLabel')}
              >
                {BOOKMARK_STRATEGIES.map(([value, labelKey]) => (
                  <Field key={value} orientation="horizontal">
                    <RadioGroupItem value={value} id={`im-bm-${value}`} />
                    <FieldLabel htmlFor={`im-bm-${value}`} className="font-normal">
                      {t(labelKey)}
                    </FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
              <FieldDescription>{t('bmMergeHint')}</FieldDescription>
            </FieldSet>
            <SwitchRow
              id="im-skip-dupes"
              label={t('importSkipDuplicates')}
              checked={settings.skipDupes}
              disabled={replacing}
              onChange={(value) => patch({ skipDupes: value })}
            />
          </SettingsSection>
        )}

        {many && (
          <ToneAlert id="many-tabs-notice" tone={TONE.warning} role="status">
            {t('importManyTabs', fmt(selectedTabs))}
          </ToneAlert>
        )}

        {importMessage?.text && (
          <ToneAlert id="import-message" tone={importMessage.tone ?? TONE.warning}>
            {importMessage.text}
          </ToneAlert>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t bg-background px-4 py-3">
        {nothingToRestore && (
          <p id="import-empty-hint" role="status" className="text-sm text-warning">
            {t('importNothingSelected')}
          </p>
        )}
        <Button id="btn-import" size="lg" className="w-full" disabled={startDisabled} onClick={handleStartClick}>
          {starting ? <Spinner data-icon="inline-start" /> : <ArchiveRestoreIcon data-icon="inline-start" />}
          {buttonLabel(restoringTabs, bookmarksOn)}
        </Button>
      </div>

      <AlertDialog open={confirming && !running} onOpenChange={setConfirming}>
        <AlertDialogContent id="replace-confirm" size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('replaceConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('replaceConfirmText')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {/* Radix focuses Cancel when the dialog opens: the safe choice. */}
            <AlertDialogCancel id="btn-replace-no">{t('replaceConfirmNo')}</AlertDialogCancel>
            <AlertDialogAction
              id="btn-replace-yes"
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                void startImport();
              }}
            >
              {t('replaceConfirmYes')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
