/**
 * Popup UI.
 *
 * The popup only renders state and sends commands to the background (see the
 * protocol in lib/types.ts). Export, import and snapshots all run there, so
 * closing the popup (or Firefox closing it for a file dialog) never interrupts work.
 *
 * The same page also runs as a full tab: popup.html?view=tab#import.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  DownloadIcon,
  ExternalLinkIcon,
  HistoryIcon,
  MoonIcon,
  MoreHorizontalIcon,
  ClipboardCopyIcon,
  KeyboardIcon,
  SunIcon,
  UploadIcon,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/sonner';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { browser as ext } from 'wxt/browser';
import { send } from '@/lib/messaging';
import { t, tp } from '@/lib/i18n';
import { isTabView, resolveTheme, toggleTheme } from '@/lib/theme';
import type { ImportState } from '@/lib/types';
import { copyText, fmt, messageOf, tabFromHash, TONE, errorDetail, type SetStatus, type TabName, type Tone } from './shared';
import { useImportCandidate } from './hooks/useImportCandidate';
import { useWorkerSync } from './hooks/useWorkerSync';
import { ExportPanel } from './components/ExportPanel';
import { ImportPanel } from './components/ImportPanel';
import { BackupsPanel } from './components/BackupsPanel';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { describeFinish } from './components/ResultsCard';

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

const TABS: Array<{ name: TabName; labelKey: string; icon: LucideIcon }> = [
  { name: 'export', labelKey: 'tabExport', icon: UploadIcon },
  { name: 'import', labelKey: 'tabImport', icon: DownloadIcon },
  { name: 'backups', labelKey: 'tabBackups', icon: HistoryIcon },
];

const TOAST_BY_TONE: Record<Tone, (text: string) => void> = {
  'is-error': (text) => toast.error(text),
  'is-success': (text) => toast.success(text),
  'is-warning': (text) => toast.warning(text),
};

export function App() {
  const [tabView] = useState(isTabView);
  const [tab, setTab] = useState<TabName>(() => tabFromHash() ?? 'export');
  /** Shown in the progress strip while a restore runs. */
  const [progressMessage, setProgressMessage] = useState('');
  const [importState, setImportState] = useState<ImportState>(IDLE);
  const [dismissedFinish, setDismissedFinish] = useState<string | null>(null);
  const [dark, setDark] = useState(() => resolveTheme() === 'dark');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const reportedFinish = useRef<string | null>(null);
  /** Current tab for callbacks: the finish toast is skipped when the results view is on screen. */
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const importer = useImportCandidate();
  /** The file in the Import tab; the Backups search covers it too. */
  const { candidate } = importer;
  const loadedFile = useMemo(
    () => (candidate?.fileName ? { data: candidate.data, name: candidate.fileName } : null),
    [candidate],
  );

  /** Outcomes are toasts; ongoing progress lives in the progress strip instead. */
  const setStatus: SetStatus = useCallback((text, tone) => {
    if (tone) TOAST_BY_TONE[tone](text);
    else toast(text);
  }, []);

  /** Progress and finish reporting for every state the worker tells us about. */
  const applyImportState = useCallback(
    (state: ImportState) => {
      setImportState(state);
      if (isRunning(state)) {
        setDismissedFinish(null);
        reportedFinish.current = null;
        if (state.status === 'cancelling') {
          setProgressMessage(t('statusCancelling'));
        } else {
          const phaseKey = state.phase ? PHASE_KEYS[state.phase] : undefined;
          setProgressMessage(phaseKey ? t(phaseKey) : state.message || t('statusRestoring'));
        }
        return;
      }
      if (!isFinished(state)) return;
      // Reported once per finish so it can't clobber later messages.
      const key = state.finishedAt ?? state.status;
      if (key === reportedFinish.current) return;
      reportedFinish.current = key;
      const outcome = describeFinish(state);
      // On the Import tab the results view already says this; a toast would only repeat it.
      if (outcome && tabRef.current !== 'import') setStatus(outcome.message, outcome.tone);
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
    <TooltipProvider>
      <div className="flex h-full flex-col bg-background text-foreground">
        <header className="flex items-center gap-2.5 border-b px-4 py-2.5">
          <img src="/icon/48.png" alt="" className="size-7" width={28} height={28} />
          <h1 className="text-sm font-semibold">{t('extName')}</h1>
          <Badge id="browser-badge" variant="outline" className="font-normal text-muted-foreground">
            {browser.name || t('unknownBrowser')}
          </Badge>
          <div className="ml-auto flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  id="btn-theme"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={themeLabel}
                  onClick={() => {
                    toggleTheme();
                    setDark(resolveTheme() === 'dark');
                  }}
                >
                  {dark ? <SunIcon /> : <MoonIcon />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{themeLabel}</TooltipContent>
            </Tooltip>
            {/* Not modal: a modal menu marks the header and the whole page aria-hidden while it is open. */}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button id="btn-menu" variant="ghost" size="icon-sm" aria-label={t('menuMore')}>
                  <MoreHorizontalIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  {!tabView && (
                    <DropdownMenuItem id="btn-open-tab" onSelect={() => void openInTab(tab)}>
                      <ExternalLinkIcon />
                      {t('openInTab')}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem id="btn-shortcuts" onSelect={() => setShortcutsOpen(true)}>
                    <KeyboardIcon />
                    {t('shortcutsMenu')}
                  </DropdownMenuItem>
                  <DropdownMenuItem id="btn-diagnostics" onSelect={() => void copyDiagnostics()}>
                    <ClipboardCopyIcon />
                    {t('diagnosticsButton')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <main className="flex min-h-0 flex-1 flex-col">
          {/* On the Import tab the progress view shows this; the strip is for the other tabs. */}
          {running && tab !== 'import' && (
            <div className="flex flex-col gap-1.5 border-b px-4 py-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate text-muted-foreground">{progressMessage}</span>
                <span id="progress-text" className="tabular-nums text-muted-foreground">
                  {total > 0 ? `${fmt(current)} / ${fmt(total)}` : ''}
                </span>
              </div>
              <div
                id="progress-bar"
                className="h-1.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={t('progressLabel')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percent)}
              >
                <div className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
              </div>
            </div>
          )}

          <Tabs value={tab} onValueChange={(value) => setTab(value as TabName)} className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="px-4 pt-3 pb-2">
              <TabsList aria-label={t('tabsAriaLabel')} className="w-full">
                {TABS.map(({ name, labelKey, icon: Icon }) => (
                  <TabsTrigger key={name} value={name} className="flex-1">
                    <Icon />
                    {t(labelKey)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>

            {/* tabIndex -1: Radix makes a panel a tab stop by default, but every panel holds controls (and has no focus ring). */}
          {/* forceMount keeps each tab's state (a loaded backup, typed filters) while switching. */}
            <TabsContent value="export" forceMount tabIndex={-1} className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <ExportPanel setStatus={setStatus} />
            </TabsContent>
            <TabsContent value="import" forceMount tabIndex={-1} className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
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
            </TabsContent>
            <TabsContent value="backups" forceMount tabIndex={-1} className="flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden">
              <BackupsPanel
                active={tab === 'backups'}
                browser={browser}
                restoreRunning={running}
                setStatus={setStatus}
                loadedFile={loadedFile}
                onRestoreSearch={(data, count) => {
                  importer.reset();
                  importer.accept({ data, label: t('formatSearchResults'), warnings: undefined, message: tp('fileLoadedSearch', count, fmt(count)) });
                  setTab('import');
                }}
                onRestore={({ data, warnings, date }) => {
                  importer.reset();
                  importer.accept({ data, label: t('formatSnapshot'), warnings, message: t('fileLoadedSnapshot', date) });
                  setTab('import');
                }}
              />
            </TabsContent>
          </Tabs>
        </main>
        {/* Bottom, just above each panel's pinned action bar (~68px): keeps the header and tabs visible. */}
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} browserInfo={browser} />
        <Toaster position="bottom-center" offset={{ bottom: 76 }} mobileOffset={{ bottom: 76 }} richColors closeButton duration={4000} />
      </div>
    </TooltipProvider>
  );
}
