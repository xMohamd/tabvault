import { useRef, useState, type ChangeEvent, type DragEvent, type MouseEvent, type Ref } from 'react';
import { send } from '@/lib/messaging';
import { t, tp } from '@/lib/i18n';
import { parseBackupFile } from '@/lib/formats';
import { BackupFormatError, countBookmarks, countGroups, countTabs, normalizeBackup, type NormalizeWarnings } from '@/lib/schema';
import type { BrowserInfo } from '@/lib/browser-detect';
import type { BookmarkStrategy, ImportOptions, ImportState, RestoreMode } from '@/lib/types';
import {
  cx,
  errorDetail,
  fmt,
  formatDate,
  MANY_TABS_THRESHOLD,
  TONE,
  type SetStatus,
  type TabName,
} from '../shared';
import type { Candidate, ImportCandidateApi } from '../hooks/useImportCandidate';
import { CheckboxSimple, CheckboxWrap, Hint, Panel, PanelIntro, Stat } from './ui';
import { defaultSelection, PreviewCard, selectedData, selectedTabCount, type WindowSelection } from './PreviewTree';
import { ResultsCard } from './ResultsCard';

/** Format keys returned by parseBackupFile -> message keys (so labels are localized). */
const FORMAT_LABEL_KEYS: Record<string, string> = {
  native: 'formatNative',
  onetab: 'formatOnetab',
  'session-buddy': 'formatSessionBuddy',
  'netscape-html': 'formatNetscapeHtml',
  'firefox-bookmarks-json': 'formatFirefoxBookmarks',
  'url-list': 'formatUrlList',
};

/** Options that survive loading another backup. */
interface RestoreSettings {
  restoreMode: RestoreMode;
  skipOpen: boolean;
  skipBlank: boolean;
  restoreLayout: boolean;
  bmStrategy: BookmarkStrategy;
  skipDupes: boolean;
}
const DEFAULT_SETTINGS: RestoreSettings = {
  restoreMode: 'discard',
  skipOpen: true,
  skipBlank: true,
  restoreLayout: true,
  bmStrategy: 'merge',
  skipDupes: true,
};

/** Invalid-entry counts only exist before normalisation, so native files are re-checked. */
function collectWarnings(text: string, parsed: { format: string; data: unknown }): NormalizeWarnings {
  const none = { invalidTabs: 0, invalidWindows: 0, invalidBookmarks: 0, newerSchema: false };
  try {
    const raw = parsed.format === 'native' ? JSON.parse(text.replace(/^﻿/, '')) : parsed.data;
    return normalizeBackup(raw).warnings;
  } catch {
    return none;
  }
}

interface PanelProps {
  active: boolean;
  browser: BrowserInfo;
  importState: ImportState;
  resultsVisible: boolean;
  isTabView: boolean;
  importer: ImportCandidateApi;
  setStatus: SetStatus;
  onDismissResults: () => void;
  openInTab: (tab: TabName) => void;
  /** The worker accepted IMPORT_START but its broadcast has not arrived yet. */
  onStartAccepted: () => void;
}

export function ImportPanel(props: PanelProps) {
  const { active, browser, importState, resultsVisible, isTabView, importer, setStatus } = props;
  const { candidate, fileInfo, importMessage, setFileInfo, setImportMessage, reset, accept } = importer;
  const [settings, setSettings] = useState<RestoreSettings>(DEFAULT_SETTINGS);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = importState.status === 'running' || importState.status === 'cancelling';

  async function handleFile(file: File | undefined) {
    if (!file) return;
    const clearInput = () => {
      if (fileInput.current) fileInput.current.value = ''; // So the same file can be chosen again.
    };
    if (running) {
      setImportMessage({ text: t('importBusy'), tone: TONE.warning });
      clearInput();
      return;
    }
    reset();

    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      console.warn('[TabVault] File read failed', error);
      setFileInfo({ text: t('fileUnreadable'), tone: TONE.error });
      return;
    } finally {
      clearInput();
    }

    try {
      const parsed = parseBackupFile(text, {
        filename: file.name,
        parseHtml: (html) => new DOMParser().parseFromString(html, 'text/html'),
      });
      const labelKey = FORMAT_LABEL_KEYS[parsed.format];
      accept({
        data: parsed.data,
        label: labelKey ? t(labelKey) : parsed.label,
        warnings: collectWarnings(text, parsed),
        message: t('fileLoaded', file.name),
      });
    } catch (error) {
      if (error instanceof BackupFormatError) {
        setFileInfo({ text: t('fileInvalid', error.message), tone: TONE.error });
      } else {
        console.warn('[TabVault] File parse failed', error);
        setFileInfo({ text: t('fileUnexpected'), tone: TONE.error });
      }
    }
  }

  /** Firefox closes the popup when a file dialog opens, so the picker lives in the tab view. */
  function handleInputClick(event: MouseEvent<HTMLInputElement>) {
    if (!isTabView && browser.key === 'firefox') {
      event.preventDefault();
      props.openInTab('import');
    }
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    void handleFile(event.dataTransfer?.files?.[0]);
  };

  return (
    <Panel name="import" active={active}>
      <PanelIntro title={t('importTitle')} text={t('importIntro')} />

      {/* Rendered from the worker's import state, so it survives reopening the popup. */}
      <ResultsCard state={importState} visible={resultsVisible} onDismiss={props.onDismissResults} setStatus={setStatus} />

      <div
        className={cx('card', 'upload-card', dragOver && 'is-dragover')}
        id="upload-card"
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <label className="file-upload-box" htmlFor="import-file">
          <input
            ref={fileInput}
            type="file"
            id="import-file"
            accept=".json,.txt,.html,.htm,application/json,text/plain,text/html"
            disabled={running}
            onClick={handleInputClick}
            onChange={(event) => void handleFile(event.target.files?.[0])}
          />
          <svg className="upload-graphic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4.5 19.5A1.5 1.5 0 0 1 3 18V6.2a1.5 1.5 0 0 1 1.5-1.5h4L10 7h9a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5Z" />
            <path d="M12 15.5v-5M9.8 12.4 12 10.2l2.2 2.2" />
          </svg>
          <span className="upload-text">{t('importChooseFile')}</span>
          <span className="upload-sub">{t('importFileSub')}</span>
        </label>
        <Hint id="file-info" text={fileInfo?.text} tone={fileInfo?.tone} />
      </div>

      {candidate ? (
        <ImportSession
          key={candidate.id}
          candidate={candidate}
          browser={browser}
          importState={importState}
          running={running}
          settings={settings}
          setSettings={setSettings}
          importMessage={importMessage}
          setImportMessage={setImportMessage}
          setStatus={setStatus}
          onStartAccepted={props.onStartAccepted}
        />
      ) : (
        <>
          <Hint id="import-message" className="no-top" text={importMessage?.text} tone={importMessage?.tone} />
          <ImportActions startDisabled running={running} cancelling={importState.status === 'cancelling'} setStatus={setStatus} />
        </>
      )}
    </Panel>
  );
}

function ImportActions({
  startDisabled,
  hideStart,
  running,
  cancelling,
  onStart,
  startRef,
  setStatus,
}: {
  startDisabled: boolean;
  hideStart?: boolean;
  running: boolean;
  cancelling: boolean;
  onStart?: () => void;
  startRef?: Ref<HTMLButtonElement>;
  setStatus: SetStatus;
}) {
  const [cancelBusy, setCancelBusy] = useState(false);

  async function handleCancel() {
    setCancelBusy(true);
    const response = await send('IMPORT_CANCEL');
    setCancelBusy(false);
    // On success the broadcast ("cancelling") keeps the button disabled.
    if (!response.ok) setStatus(errorDetail(response), TONE.error);
  }

  return (
    <div className="actions-footer">
      <button
        type="button"
        id="btn-import"
        ref={startRef}
        className={cx('btn-primary', hideStart && 'hidden')}
        disabled={startDisabled}
        onClick={onStart}
      >
        {t('importStart')}
      </button>
      <button
        type="button"
        id="btn-cancel"
        className={cx('btn-cancel', !running && 'hidden')}
        disabled={cancelling || cancelBusy}
        onClick={handleCancel}
      >
        {t('importCancel')}
      </button>
    </div>
  );
}

interface SessionProps {
  candidate: Candidate;
  browser: BrowserInfo;
  importState: ImportState;
  running: boolean;
  settings: RestoreSettings;
  setSettings: (next: RestoreSettings) => void;
  importMessage: ImportCandidateApi['importMessage'];
  setImportMessage: ImportCandidateApi['setImportMessage'];
  setStatus: SetStatus;
  onStartAccepted: () => void;
}

/** Everything that exists only while a backup is loaded. Keyed by candidate id, so a new backup starts fresh. */
function ImportSession(props: SessionProps) {
  const { candidate, browser, importState, running, settings, importMessage, setImportMessage, setStatus } = props;
  const { data, hasTabs, hasBookmarks } = candidate;
  const [selection, setSelection] = useState<WindowSelection[]>(() => defaultSelection(data));
  const bookmarksSupported = browser.features?.bookmarks !== false;
  const [importTabs, setImportTabs] = useState(hasTabs);
  const [importBookmarks, setImportBookmarks] = useState(hasBookmarks && bookmarksSupported);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const startButton = useRef<HTMLButtonElement>(null);

  const tabsOn = hasTabs && importTabs;
  const bookmarksOn = hasBookmarks && bookmarksSupported && importBookmarks;
  const selectedTabs = selectedTabCount(data, selection);
  const replacing = settings.bmStrategy === 'replace';
  const showConfirm = confirming && !running;
  const many = tabsOn && selectedTabs > MANY_TABS_THRESHOLD;
  const startDisabled = running || starting || !((tabsOn && selectedTabs > 0) || bookmarksOn);

  /** Any change to what will be restored invalidates a pending replace confirmation. */
  const touched = <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => {
    setConfirming(false);
    fn(...args);
  };
  const patch = (next: Partial<RestoreSettings>) => props.setSettings({ ...settings, ...next });

  const groupCount = countGroups(data);
  const date = formatDate(data.exportedAt);
  const warnings = candidate.warnings;
  const invalid = (warnings?.invalidTabs ?? 0) + (warnings?.invalidWindows ?? 0) + (warnings?.invalidBookmarks ?? 0);
  const notes = [
    ...(invalid > 0 ? [tp('warnInvalidEntries', invalid, fmt(invalid))] : []),
    ...(warnings?.newerSchema ? [t('warnNewerSchema')] : []),
    ...(data.source?.truncated ? [t('warnTruncated')] : []),
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

  return (
    <>
      <div className="card" id="import-summary">
        <h3 className="section-label">{t('summaryTitle')}</h3>
        <p id="summary-format" className="summary-line">
          {t('summaryFormat', candidate.label)}
        </p>
        <div id="summary-stats" className="stat-row">
          <Stat value={countTabs(data)} label={t('labelTabs')} />
          <Stat value={data.windows.length} label={t('labelWindows')} />
          <Stat value={groupCount} label={t('labelGroups')} />
          <Stat value={countBookmarks(data.bookmarks)} label={t('labelBookmarks')} />
        </div>
        <p id="summary-date" className={cx('field-hint', !date && 'hidden')}>
          {date ? t('summaryDate', date) : ''}
        </p>
        <div id="summary-warnings">
          {notes.map((note) => (
            <Hint key={note} live={false} tone={TONE.warning} text={note} />
          ))}
        </div>
      </div>

      {tabsOn && (
        <PreviewCard data={data} selection={selection} onChange={touched(setSelection)} />
      )}

      {(hasTabs || (hasBookmarks && bookmarksSupported)) && (
        <div className="card" id="import-options">
          <h3 className="section-label" id="import-content-label">
            {t('importWhatLabel')}
          </h3>
          <div className="checkbox-group horizontal" role="group" aria-labelledby="import-content-label">
            <CheckboxWrap id="im-tabs" compact hidden={!hasTabs} checked={importTabs} onChange={touched(setImportTabs)} primary={t('importTabsOption')} />
            <CheckboxWrap
              id="im-bookmarks"
              compact
              hidden={!(hasBookmarks && bookmarksSupported)}
              checked={importBookmarks}
              onChange={touched(setImportBookmarks)}
              primary={t('importBookmarksOption')}
            />
          </div>
        </div>
      )}

      {tabsOn && (
        <div className="card" id="tab-options">
          <h3 className="section-label">{t('importTabOptionsLabel')}</h3>
          <div className="form-row">
            <label htmlFor="im-restore-mode">{t('importLoadingLabel')}</label>
            <select
              id="im-restore-mode"
              value={settings.restoreMode}
              onChange={touched((event: ChangeEvent<HTMLSelectElement>) => patch({ restoreMode: event.target.value as RestoreMode }))}
            >
              <option value="discard">{t('loadDiscard')}</option>
              <option value="lazy">{t('loadLazy')}</option>
              <option value="load">{t('loadLoad')}</option>
            </select>
          </div>
          <div className="check-list">
            <CheckboxSimple id="im-skip-open" checked={settings.skipOpen} onChange={touched((v: boolean) => patch({ skipOpen: v }))}>
              {t('importSkipOpen')}
            </CheckboxSimple>
            <CheckboxSimple id="im-skip-blank" checked={settings.skipBlank} onChange={touched((v: boolean) => patch({ skipBlank: v }))}>
              {t('importSkipBlank')}
            </CheckboxSimple>
            <CheckboxSimple id="im-restore-layout" checked={settings.restoreLayout} onChange={touched((v: boolean) => patch({ restoreLayout: v }))}>
              {t('importRestoreLayout')}
            </CheckboxSimple>
          </div>
          <p id="im-no-groups-hint" className={cx('field-hint', browser.features?.tabGroups !== false && 'hidden')}>
            {t('importNoTabGroups')}
          </p>
        </div>
      )}

      {hasBookmarks && (bookmarksOn || !bookmarksSupported) && (
        <div className="card" id="bookmark-options">
          {bookmarksSupported && bookmarksOn && (
            <fieldset className="plain-fieldset" id="bm-controls">
              <legend className="section-label">{t('importBookmarkOptionsLabel')}</legend>
              <div className="radio-group-vertical">
                {(
                  [
                    ['merge', 'bmMerge'],
                    ['folder', 'bmFolder'],
                    ['replace', 'bmReplace'],
                  ] as const
                ).map(([value, labelKey]) => (
                  <label className="radio-wrap" key={value}>
                    <input
                      type="radio"
                      name="bm-strategy"
                      className="control-input"
                      value={value}
                      checked={settings.bmStrategy === value}
                      onChange={touched(() => patch({ bmStrategy: value }))}
                    />
                    <span className="radio-custom" aria-hidden="true" />
                    <span>{t(labelKey)}</span>
                  </label>
                ))}
              </div>
              <p className="field-hint">{t('bmMergeHint')}</p>
              <div className="check-list spaced">
                <CheckboxSimple id="im-skip-dupes" checked={settings.skipDupes} disabled={replacing} onChange={touched((v: boolean) => patch({ skipDupes: v }))}>
                  {t('importSkipDuplicates')}
                </CheckboxSimple>
              </div>
            </fieldset>
          )}
          {!bookmarksSupported && (
            <p id="bm-unsupported" className="inline-hint is-warning no-top">
              {t('importNoBookmarksApi')}
            </p>
          )}
        </div>
      )}

      <Hint id="many-tabs-notice" className="no-top" tone={TONE.warning} text={many ? t('importManyTabs', fmt(selectedTabs)) : null} />
      <Hint id="import-message" className="no-top" text={importMessage?.text} tone={importMessage?.tone} />

      {showConfirm && (
        <div id="replace-confirm" className="confirm-panel" role="alertdialog" aria-labelledby="replace-confirm-text">
          <p id="replace-confirm-text">{t('replaceConfirmText')}</p>
          <div className="confirm-actions">
            <button
              type="button"
              id="btn-replace-yes"
              className="btn-danger"
              onClick={() => {
                setConfirming(false);
                void startImport();
              }}
            >
              {t('replaceConfirmYes')}
            </button>
            <button
              type="button"
              id="btn-replace-no"
              className="btn-secondary"
              autoFocus // The safe choice gets the focus.
              onClick={() => {
                setConfirming(false);
                // The start button is re-rendered visible on the next frame.
                requestAnimationFrame(() => startButton.current?.focus());
              }}
            >
              {t('replaceConfirmNo')}
            </button>
          </div>
        </div>
      )}

      <ImportActions
        startDisabled={startDisabled}
        hideStart={showConfirm}
        running={running}
        cancelling={importState.status === 'cancelling'}
        onStart={handleStartClick}
        startRef={startButton}
        setStatus={setStatus}
      />
    </>
  );
}
