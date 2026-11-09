/**
 * Review step of the Import tab: what the loaded backup contains, what to restore,
 * the restore options, and the main action pinned at the bottom.
 * Keyed by candidate id, so a new backup starts with fresh selections.
 */
import { useMemo, useRef, useState } from 'react';
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
import { searchBackups } from '@/lib/snapshot-search';
import type { BookmarkStrategy, ImportOptions, RestoreMode, SearchResult } from '@/lib/types';
import { errorDetail, fmt, formatDate, MANY_TABS_THRESHOLD, TONE, type SetStatus } from '../shared';
import type { Candidate, ImportCandidateApi } from '../hooks/useImportCandidate';
import {
  defaultSelection,
  PreviewCard,
  selectedData,
  selectedTabCount,
  selectionForKeys,
  type WindowSelection,
} from './PreviewTree';
import { useFocusOnMount } from './ImportProgress';
import { ImportSearch } from './ImportSearch';
import { SettingsSection, SwitchRow } from './settings';
import { ToneAlert } from './ToneAlert';


/** Most matches listed when searching the loaded file. */
const SEARCH_LIMIT = 100_000;

/** Options that survive loading another backup. */
export interface RestoreSettings {
  restoreMode: RestoreMode;
  skipOpen: boolean;
  skipBlank: boolean;
  restoreLayout: boolean;
  bmStrategy: BookmarkStrategy;
  skipDupes: boolean;
  target: NonNullable<ImportOptions['target']>;
  mergeGroups: boolean;
  restoreContainers: boolean;
}
export const DEFAULT_SETTINGS: RestoreSettings = {
  restoreMode: 'discard',
  skipOpen: true,
  skipBlank: true,
  restoreLayout: true,
  bmStrategy: 'merge',
  skipDupes: true,
  target: 'new-windows',
  mergeGroups: false,
  restoreContainers: true,
};

/** Short loading-mode words for the collapsed section's summary badge. */
const LOAD_MODE_SHORT: Record<string, string> = { discard: 'loadShortDiscard', lazy: 'loadShortLazy', load: 'loadShortLoad' };

const LOAD_MODES: Array<[RestoreMode, string]> = [
  ['discard', 'loadDiscard'],
  ['lazy', 'loadLazy'],
  ['load', 'loadLoad'],
];
const TARGETS: Array<[RestoreSettings['target'], string]> = [
  ['new-windows', 'importTargetNew'],
  ['current-window', 'importTargetCurrent'],
];
const BOOKMARK_STRATEGIES: Array<[BookmarkStrategy, string]> = [
  ['merge', 'bmMerge'],
  ['folder', 'bmFolder'],
  ['replace', 'bmReplace'],
];

function StatCell({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xl font-semibold tracking-tight tabular-nums">{fmt(value)}</span>
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
  // Search inside the file. Ticked results (kept while the query is refined) are all that gets restored.
  const [query, setQueryText] = useState('');
  const [picked, setPicked] = useState<Map<string, SearchResult>>(new Map());
  const bookmarksSupported = browser.features?.bookmarks !== false;
  const [importTabs, setImportTabs] = useState(hasTabs);
  const [importBookmarks, setImportBookmarks] = useState(hasBookmarks && bookmarksSupported);
  const bookmarkletCount = countBookmarklets(data.bookmarks);
  const [importBookmarklets, setImportBookmarklets] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const focusOnMount = useFocusOnMount();
  const importButton = useRef<HTMLButtonElement>(null);

  const currentWindow = settings.target === 'current-window';
  const tabGroupsSupported = browser.features?.tabGroups !== false;
  const hasContainers = data.windows.some((win) =>
    [...win.ungroupedTabs, ...win.groups.flatMap((group) => group.tabs)].some((tab) => tab.container),
  );
  const showContainers = browser.key === 'firefox' && hasContainers;
  const tabsOn = hasTabs && importTabs;
  const bookmarksOn = hasBookmarks && bookmarksSupported && importBookmarks;

  // Search: the file's tabs and bookmarks, limited to the kinds the "What to restore" switches leave on.
  const searchable = hasTabs || (hasBookmarks && bookmarksSupported);
  const searching = searchable && query.trim() !== '';
  const results = useMemo(
    () =>
      searching
        ? searchBackups([{ id: 'file', label: '', date: data.exportedAt ?? null, data }], query, {
            limit: SEARCH_LIMIT,
            kinds: [...(tabsOn ? (['tab'] as const) : []), ...(bookmarksOn ? (['bookmark'] as const) : [])],
          }).results
        : [],
    [searching, data, query, tabsOn, bookmarksOn],
  );
  // Ticks of a kind that was switched off are ignored.
  const pickedList = useMemo(() => [...picked.values()].filter((r) => (r.kind === 'tab' ? tabsOn : bookmarksOn)), [picked, tabsOn, bookmarksOn]);
  const pickedTabKeys = useMemo(() => new Set(pickedList.filter((r) => r.kind === 'tab').map((r) => r.key)), [pickedList]);
  const pickedBookmarkKeys = useMemo(() => new Set(pickedList.filter((r) => r.kind === 'bookmark').map((r) => r.key)), [pickedList]);
  /** Ticked results replace the tree-based selection; windows and groups follow from the ticked tabs. */
  const picking = searching && pickedList.length > 0;
  const pickedSelection = useMemo(() => selectionForKeys(data, pickedTabKeys), [data, pickedTabKeys]);

  const tabsActive = picking ? pickedTabKeys.size > 0 : tabsOn;
  const bookmarksActive = picking ? pickedBookmarkKeys.size > 0 : bookmarksOn;
  const selectedTabs = picking ? selectedTabCount(data, pickedSelection, pickedTabKeys) : selectedTabCount(data, selection);
  const restoringTabs = tabsActive ? selectedTabs : 0;
  const replacing = settings.bmStrategy === 'replace';
  const many = tabsActive && selectedTabs > MANY_TABS_THRESHOLD;
  const nothingToRestore = searching ? !picking : !((tabsOn && selectedTabs > 0) || bookmarksOn);
  const startDisabled = running || starting || nothingToRestore;

  /** Clearing the search also clears the ticks: back to the normal restore. */
  const changeQuery = (next: string) => {
    setQueryText(next);
    if (next.trim() === '') setPicked(new Map());
  };

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
    if (bookmarksActive && replacing) {
      setConfirming(true);
      return;
    }
    void startImport();
  }

  async function startImport() {
    const options: ImportOptions = {
      importTabs: tabsActive,
      importBookmarks: bookmarksActive,
      bookmarkStrategy: settings.bmStrategy,
      skipDuplicateBookmarks: settings.skipDupes && !replacing,
      importBookmarklets,
      restoreMode: settings.restoreMode,
      restoreWindowLayout: settings.restoreLayout && !currentWindow,
      target: settings.target,
      mergeGroups: tabGroupsSupported && settings.mergeGroups,
      ...(showContainers ? { restoreContainers: settings.restoreContainers } : {}),
      skipOpenTabs: settings.skipOpen,
      skipBlankTabs: settings.skipBlank,
      focusRestored: false,
    };
    setImportMessage(null);
    setStarting(true);
    const chosen = picking ? selectedData(data, pickedSelection, pickedTabKeys, pickedBookmarkKeys) : selectedData(data, selection);
    const response = await send('IMPORT_START', { data: chosen, options });
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
  // The badge sits beside the section title, so it uses short words ("Unloaded · Current window").
  const loadModeShort = t(LOAD_MODE_SHORT[settings.restoreMode] ?? 'loadShortDiscard');
  const tabOptionsSummary = currentWindow ? `${loadModeShort} · ${t('importTargetCurrent')}` : loadModeLabel;
  const strategyLabel = t(BOOKMARK_STRATEGIES.find(([value]) => value === settings.bmStrategy)?.[1] ?? 'bmMerge');
  const noTabGroups = browser.features?.tabGroups === false;

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-2 pb-4">
        <section
          id="import-summary"
          ref={focusOnMount}
          tabIndex={-1}
          aria-label={t('summaryTitle')}
          className="flex flex-col gap-3 rounded-lg border bg-card px-3 py-3 outline-none"
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
            <StatCell value={countTabs(data)} label={tp('labelTabs', countTabs(data))} />
            <StatCell value={data.windows.length} label={tp('labelWindows', data.windows.length)} />
            <StatCell value={countGroups(data)} label={tp('labelGroups', countGroups(data))} />
            <StatCell value={countBookmarks(data.bookmarks)} label={tp('labelBookmarks', countBookmarks(data.bookmarks))} />
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

        {searchable && (
          <ImportSearch
            query={query}
            onQueryChange={changeQuery}
            results={results}
            picked={picked}
            onPickedChange={setPicked}
            showFilter={tabsOn && bookmarksOn}
          />
        )}

        {tabsOn && !searching && <PreviewCard data={data} selection={selection} onChange={setSelection} />}

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
          <SettingsSection id="tab-options" title={t('importTabOptionsLabel')} summary={tabOptionsSummary}>
            <FieldSet id="im-target-set">
              <FieldLegend variant="label">{t('importOpenInLabel')}</FieldLegend>
              <RadioGroup
                id="im-target"
                value={settings.target}
                onValueChange={(value) => patch({ target: value as RestoreSettings['target'] })}
                aria-label={t('importOpenInLabel')}
              >
                {TARGETS.map(([value, labelKey]) => (
                  <Field key={value} orientation="horizontal">
                    <RadioGroupItem value={value} id={`im-target-${value}`} />
                    <FieldLabel htmlFor={`im-target-${value}`} className="font-normal">
                      {t(labelKey)}
                    </FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
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
              description={currentWindow ? t('importLayoutNewOnly') : undefined}
              checked={settings.restoreLayout && !currentWindow}
              disabled={currentWindow}
              onChange={(value) => patch({ restoreLayout: value })}
            />
            {tabGroupsSupported && (
              <SwitchRow
                id="im-merge-groups"
                label={t('importMergeGroups')}
                description={t('importMergeGroupsHint')}
                checked={settings.mergeGroups}
                onChange={(value) => patch({ mergeGroups: value })}
              />
            )}
            {showContainers && (
              <SwitchRow
                id="im-containers"
                label={t('importContainers')}
                checked={settings.restoreContainers}
                onChange={(value) => patch({ restoreContainers: value })}
              />
            )}
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
        {nothingToRestore && !searching && (
          <p id="import-empty-hint" role="status" className="text-sm text-warning">
            {t('importNothingSelected')}
          </p>
        )}
        <Button ref={importButton} id="btn-import" size="lg" className="w-full" disabled={startDisabled} onClick={handleStartClick}>
          {starting ? <Spinner data-icon="inline-start" /> : <ArchiveRestoreIcon data-icon="inline-start" />}
          {searching ? (picking ? t('searchRestoreSelected', fmt(pickedList.length)) : t('searchSelectToRestore')) : buttonLabel(restoringTabs, bookmarksOn)}
        </Button>
      </div>

      <AlertDialog open={confirming && !running} onOpenChange={setConfirming}>
        <AlertDialogContent
          id="replace-confirm"
          size="sm"
          // The dialog has no trigger element, so Radix would drop focus on <body>: return it to the button that opened it.
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            importButton.current?.focus();
          }}
        >
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
