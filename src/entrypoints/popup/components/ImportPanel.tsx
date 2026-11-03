/**
 * Import tab. One body at a time, chosen from the worker's import state and the loaded backup:
 * running → progress, finished → results, backup loaded → review, otherwise → choose a file.
 * The review stays mounted (hidden) behind the others so selections survive a restore.
 */
import { useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { ExternalLinkIcon, FileUpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { t } from '@/lib/i18n';
import { parseBackupFile } from '@/lib/formats';
import { BackupFormatError, normalizeBackup, type NormalizeWarnings } from '@/lib/schema';
import type { BrowserInfo } from '@/lib/browser-detect';
import type { ImportState } from '@/lib/types';
import { cn } from '@/lib/utils';
import { TONE, type SetStatus, type TabName } from '../shared';
import type { ImportCandidateApi } from '../hooks/useImportCandidate';
import { DEFAULT_SETTINGS, ImportReview, type RestoreSettings } from './ImportReview';
import { ImportProgress } from './ImportProgress';
import { ResultsCard } from './ResultsCard';
import { ToneAlert } from './ToneAlert';

/** Format keys returned by parseBackupFile -> message keys (so labels are localized). */
const FORMAT_LABEL_KEYS: Record<string, string> = {
  native: 'formatNative',
  onetab: 'formatOnetab',
  'session-buddy': 'formatSessionBuddy',
  'netscape-html': 'formatNetscapeHtml',
  'firefox-bookmarks-json': 'formatFirefoxBookmarks',
  'url-list': 'formatUrlList',
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
  const { browser, importState, resultsVisible, isTabView, importer, setStatus } = props;
  const { candidate, fileInfo, importMessage, setFileInfo, setImportMessage, reset, accept } = importer;
  const [settings, setSettings] = useState<RestoreSettings>(DEFAULT_SETTINGS);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const running = importState.status === 'running' || importState.status === 'cancelling';
  const view = running ? 'running' : resultsVisible ? 'results' : candidate ? 'review' : 'empty';

  async function handleFile(file: File | undefined) {
    if (!file) return;
    const clearInput = () => {
      if (fileInput.current) fileInput.current.value = ''; // So the same file can be chosen again.
    };
    if (running) {
      setImportMessage({ text: t('importBusy'), tone: TONE.warning });
      setStatus(t('importBusy'), TONE.warning); // The progress view does not show import messages.
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

  /**
   * Browsers close an action popup when it loses focus, and opening the native file
   * dialog takes focus away (always in Firefox; in Chrome on Linux and some other
   * setups). The popup and its file input are destroyed, so the chosen file is lost.
   * In popup mode the picker therefore lives in the full-tab view. Drag & drop onto
   * the popup still works: it opens no dialog.
   */
  function handleInputClick(event: MouseEvent<HTMLInputElement>) {
    if (!isTabView) {
      event.preventDefault();
      props.openInTab('import');
    }
  }

  const chooseFile = () => fileInput.current?.click();

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    void handleFile(event.dataTransfer?.files?.[0]);
  };

  return (
    <div
      id="import-panel"
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        // Moving between child elements also fires dragleave; only leaving the panel counts.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <input
        ref={fileInput}
        type="file"
        id="import-file"
        className="hidden"
        tabIndex={-1}
        accept=".json,.txt,.html,.htm,application/json,text/plain,text/html"
        disabled={running}
        onClick={handleInputClick}
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />

      {view === 'empty' && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
          <Empty id="import-empty" className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileUpIcon />
              </EmptyMedia>
              <EmptyTitle>{t('importChooseFile')}</EmptyTitle>
              <EmptyDescription>{t('importFileSub')}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button type="button" id="btn-choose-file" onClick={chooseFile}>
                {isTabView ? t('importChooseButton') : t('importChooseInTab')}
                {!isTabView && <ExternalLinkIcon data-icon="inline-end" />}
              </Button>
              {!isTabView && (
                <p id="choose-in-tab-hint" className="text-xs text-muted-foreground">
                  {t('importChooseInTabHint')}
                </p>
              )}
            </EmptyContent>
          </Empty>
          {fileInfo?.text && (
            <ToneAlert id="file-info" tone={fileInfo.tone ?? TONE.warning}>
              {fileInfo.text}
            </ToneAlert>
          )}
          {importMessage?.text && (
            <ToneAlert id="import-message" tone={importMessage.tone ?? TONE.warning}>
              {importMessage.text}
            </ToneAlert>
          )}
        </div>
      )}

      {candidate && (
        <div className={cn('flex min-h-0 flex-1 flex-col', view !== 'review' && 'hidden')}>
          <ImportReview
            key={candidate.id}
            candidate={candidate}
            browser={browser}
            running={running}
            settings={settings}
            setSettings={setSettings}
            fileInfo={fileInfo}
            importMessage={importMessage}
            setImportMessage={setImportMessage}
            setStatus={setStatus}
            onChooseFile={chooseFile}
            onStartAccepted={props.onStartAccepted}
          />
        </div>
      )}

      {view === 'running' && <ImportProgress state={importState} setStatus={setStatus} />}

      {view === 'results' && (
        <ResultsCard
          state={importState}
          setStatus={setStatus}
          onDismiss={props.onDismissResults}
          onRestoreAnother={() => {
            reset();
            props.onDismissResults();
          }}
        />
      )}

      {dragOver && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/80 text-sm font-medium text-primary"
        >
          {t('importDropHere')}
        </div>
      )}
    </div>
  );
}
