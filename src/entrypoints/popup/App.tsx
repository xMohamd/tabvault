/**
 * Popup UI.
 *
 * The popup only renders state and sends commands to the background (see the
 * protocol in lib/types.ts). Export, import and snapshots all run there, so
 * closing the popup (or Firefox closing it for a file dialog) never interrupts work.
 *
 * The same page also runs as a full tab: popup.html?view=tab#import.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { browser as ext } from 'wxt/browser';
import { send } from '@/lib/messaging';
import { t } from '@/lib/i18n';
import { isTabView, resolveTheme, toggleTheme } from '@/lib/theme';
import type { ImportState } from '@/lib/types';
import { copyText, cx, fmt, messageOf, tabFromHash, TAB_ORDER, TONE, errorDetail, type Message, type SetStatus, type TabName, type Tone } from './shared';
import { useImportCandidate } from './hooks/useImportCandidate';
import { useWorkerSync } from './hooks/useWorkerSync';
import { ExportPanel } from './components/ExportPanel';
import { ImportPanel } from './components/ImportPanel';
import { BackupsPanel } from './components/BackupsPanel';
import { describeFinish } from './components/ResultsCard';

/** getURL is typed per generated public path; a plain string signature keeps this independent of that. */

const IDLE: ImportState = { status: 'idle', current: 0, total: 0, message: '' };
const PERCENT_MAX = 100;
const PHASE_KEYS: Record<string, string> = {
  starting: 'phaseStarting',
  bookmarks: 'phaseBookmarks',
  tabs: 'phaseTabs',
  done: 'phaseDone',
};
const isRunning = (state: ImportState) => state.status === 'running' || state.status === 'cancelling';
const isFinished = (state: ImportState) => state.status === 'done' || state.status === 'cancelled' || state.status === 'error';

const TABS: Array<{ name: TabName; labelKey: string; paths: string[]; circle?: boolean }> = [
  { name: 'export', labelKey: 'tabExport', paths: ['M12 16V4M8 7.5 12 3.5l4 4', 'M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15'] },
  { name: 'import', labelKey: 'tabImport', paths: ['M12 3.5v12M8 12l4 4 4-4', 'M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15'] },
  { name: 'backups', labelKey: 'tabBackups', circle: true, paths: ['M12 7.5V12l3 2'] },
];

export function App() {
  const [tabView] = useState(isTabView);
  const [tab, setTab] = useState<TabName>(() => tabFromHash() ?? 'export');
  const [status, setStatusMessage] = useState<Message>({ text: t('statusReady') });
  const [importState, setImportState] = useState<ImportState>(IDLE);
  const [dismissedFinish, setDismissedFinish] = useState<string | null>(null);
  const [dark, setDark] = useState(() => resolveTheme() === 'dark');
  const reportedFinish = useRef<string | null>(null);
  const importer = useImportCandidate();

  const setStatus: SetStatus = useCallback((text, tone) => setStatusMessage({ text, tone }), []);

  /** Progress and finish reporting for every state the worker tells us about. */
  const applyImportState = useCallback(
    (state: ImportState) => {
      setImportState(state);
      if (isRunning(state)) {
        setDismissedFinish(null);
        reportedFinish.current = null;
        if (state.status === 'cancelling') {
          setStatus(t('statusCancelling'));
        } else {
          const phaseKey = state.phase ? PHASE_KEYS[state.phase] : undefined;
          setStatus(phaseKey ? t(phaseKey) : state.message || t('statusRestoring'));
        }
        return;
      }
      if (!isFinished(state)) return;
      // Reported once per finish so it can't clobber later messages.
      const key = state.finishedAt ?? state.status;
      if (key === reportedFinish.current) return;
      reportedFinish.current = key;
      const outcome = describeFinish(state);
      if (outcome) setStatus(outcome.message, outcome.tone);
    },
    [setStatus],
  );

  const browser = useWorkerSync({
    onImportState: applyImportState,
    onError: (message) => setStatus(message, TONE.error),
    // Reopening during a restore: show it unless a tab was asked for explicitly.
    onLoaded: (running) => {
      if (!tabFromHash() && running) setTab('import');
    },
  });

  // Following #export / #import / #backups, and keeping stray file drops from navigating the page away.
  useEffect(() => {
    const onHash = () => {
      const name = tabFromHash();
      if (name) setTab(name);
    };
    const prevent = (event: Event) => event.preventDefault();
    window.addEventListener('hashchange', onHash);
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  /** Opens this page as a full tab; used for Firefox file picking and the header button. */
  const openInTab = useCallback(
    async (name: TabName) => {
      try {
        await ext.tabs.create({ url: `${ext.runtime.getURL('/popup.html')}?view=tab#${name}` });
        if (!tabView) window.close();
      } catch (error) {
        setStatus(t('openTabFailed', messageOf(error)), TONE.error);
      }
    },
    [tabView, setStatus],
  );

  function handleTabKeydown(event: KeyboardEvent<HTMLButtonElement>, current: TabName) {
    const index = TAB_ORDER.indexOf(current);
    let next: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % TAB_ORDER.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TAB_ORDER.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = TAB_ORDER[next];
    if (!target) return;
    setTab(target);
    document.getElementById(`tab-${target}`)?.focus();
  }

  async function copyDiagnostics() {
    const response = await send('DIAGNOSTICS');
    if (!response.ok) {
      setStatus(t('diagnosticsFailed', errorDetail(response)), TONE.error);
      return;
    }
    try {
      await copyText(JSON.stringify(response.report, null, 2));
      setStatus(t('diagnosticsCopied'), TONE.success);
    } catch (error) {
      setStatus(t('diagnosticsFailed', messageOf(error)), TONE.error);
    }
  }

  const running = isRunning(importState);
  const finishKey = importState.finishedAt ?? 'dismissed';
  const resultsVisible = isFinished(importState) && dismissedFinish !== finishKey;
  const { current = 0, total = 0 } = importState;
  const percent = total > 0 ? Math.min((current / total) * PERCENT_MAX, PERCENT_MAX) : 0;
  const themeLabel = dark ? t('themeToLight') : t('themeToDark');

  return (
    <div className="app-container">
      <header className="app-header">
        <img src="/icon/48.png" alt="" className="app-logo" width={32} height={32} />
        <div className="title-group">
          <h1>{t('extName')}</h1>
          <p className="browser-badge" id="browser-badge">
            {browser.name || t('unknownBrowser')}
          </p>
        </div>
        <button
          type="button"
          id="btn-open-tab"
          className="btn-icon"
          aria-label={t('openInTab')}
          title={t('openInTab')}
          hidden={tabView}
          onClick={() => void openInTab(tab)}
        >
          <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14 4h6v6M20 4l-8.5 8.5" />
            <path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
          </svg>
        </button>
        <button
          type="button"
          id="btn-theme"
          className="btn-icon"
          aria-label={themeLabel}
          title={themeLabel}
          onClick={() => {
            toggleTheme();
            setDark(resolveTheme() === 'dark');
          }}
        >
          <svg className="icon icon-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
          </svg>
          <svg className="icon icon-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="4.2" />
            <path d="M12 2.6v2.2M12 19.2v2.2M4.2 12H2M22 12h-2.2M6.5 6.5 4.9 4.9M19.1 19.1l-1.6-1.6M17.5 6.5l1.6-1.6M4.9 19.1l1.6-1.6" />
          </svg>
        </button>
      </header>

      <div className="tabs-container">
        <div className="tabs" role="tablist" aria-label={t('tabsAriaLabel')}>
          {TABS.map(({ name, labelKey, paths, circle }) => {
            const selected = tab === name;
            return (
              <button
                key={name}
                type="button"
                className={cx('tab-btn', selected && 'active')}
                id={`tab-${name}`}
                role="tab"
                aria-selected={selected}
                aria-controls={`${name}-panel`}
                // Only the selected tab stays in the tab order (roving tabindex).
                tabIndex={selected ? 0 : -1}
                onClick={() => setTab(name)}
                onKeyDown={(event) => handleTabKeydown(event, name)}
              >
                <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  {circle && <circle cx="12" cy="12" r="8.5" />}
                  {paths.map((d) => (
                    <path key={d} d={d} />
                  ))}
                </svg>
                <span>{t(labelKey)}</span>
              </button>
            );
          })}
        </div>
      </div>

      <main className="content-area">
        <ExportPanel active={tab === 'export'} setStatus={setStatus} />
        <ImportPanel
          active={tab === 'import'}
          browser={browser}
          importState={importState}
          resultsVisible={resultsVisible}
          isTabView={tabView}
          importer={importer}
          setStatus={setStatus}
          onDismissResults={() => setDismissedFinish(finishKey)}
          openInTab={(name) => void openInTab(name)}
          onStartAccepted={() => {
            // The worker's broadcast normally arrives first; this only covers a missed one.
            if (!running) applyImportState({ ...importState, status: 'running', phase: 'starting', current: 0, total: 0 });
          }}
        />
        <BackupsPanel
          active={tab === 'backups'}
          browser={browser}
          restoreRunning={running}
          onRestore={({ data, warnings, date }) => {
            importer.reset();
            importer.accept({ data, label: t('formatSnapshot'), warnings, message: t('fileLoadedSnapshot', date) });
            setTab('import');
          }}
        />
      </main>

      <footer className="app-footer">
        <div className="footer-content">
          <span id="status-msg" role="status" className={status.tone as Tone | undefined} title={status.text}>
            {status.text}
          </span>
          <span id="progress-text" className={cx(!running && 'hidden')}>
            {running && total > 0 ? `${fmt(current)} / ${fmt(total)}` : ''}
          </span>
          <button type="button" id="btn-diagnostics" className="btn-link small" onClick={() => void copyDiagnostics()}>
            {t('diagnosticsButton')}
          </button>
        </div>
        <div
          id="progress-bar"
          className={cx('progress-bar', !running && 'hidden')}
          role="progressbar"
          aria-label={t('progressLabel')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <div className="fill" style={{ width: `${percent}%` }} />
        </div>
      </footer>
    </div>
  );
}
