/** Body shown after a restore finishes: outcome, counts, problems, failed items, and the way forward. */
import { ChevronRightIcon, CopyIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { t, tp } from '@/lib/i18n';
import type { Failure, ImportState } from '@/lib/types';
import { cn } from '@/lib/utils';
import { copyText, fmt, messageOf, TONE, type SetStatus, type Tone } from '../shared';
import { useFocusOnMount } from './ImportProgress';
import { ToneAlert } from './ToneAlert';
import { useState } from 'react';

const FAILURE_REASON_KEYS: Record<string, string> = {
  'internal-page': 'failureInternalPage',
  'unsafe-scheme': 'failureUnsafeScheme',
  'file-url-blocked': 'failureFileUrlBlocked',
  'invalid-url': 'failureInvalidUrl',
  'empty-url': 'failureEmptyUrl',
  'unsupported-url': 'failureUnsupportedUrl',
  'window-create-failed': 'failureWindowCreateFailed',
};
const FAILURE_KIND_KEYS: Record<string, string> = {
  tab: 'failureKindTab',
  group: 'failureKindGroup',
  bookmark: 'failureKindBookmark',
};

const failureReason = (reason: unknown): string => {
  const key = FAILURE_REASON_KEYS[String(reason)];
  return key ? t(key) : String(reason ?? t('errorUnknown'));
};
const failureKind = (kind: unknown): string => {
  const key = FAILURE_KIND_KEYS[String(kind)];
  return key ? t(key) : String(kind ?? '');
};

/** Footer/summary sentence for a finished restore, or null while it is not finished. */
export function describeFinish(state: ImportState): { message: string; tone: Tone } | null {
  const result = state.result;
  const counts = [fmt(result?.tabs), fmt(result?.bookmarks)];
  if (state.status === 'error') return { message: t('statusImportFailed', state.error || t('errorUnknown')), tone: TONE.error };
  if (state.status === 'cancelled') return { message: t('statusImportCancelled', counts), tone: TONE.warning };
  if (state.status === 'done') {
    const problems = (result?.tabsFailed ?? 0) + (result?.bookmarksFailed ?? 0) + (result?.errors?.length ?? 0);
    return problems > 0
      ? { message: t('statusImportDoneIssues', counts), tone: TONE.warning }
      : { message: t('statusImportDone', counts), tone: TONE.success };
  }
  return null;
}

export function ResultsCard({
  state,
  onDismiss,
  onRestoreAnother,
  setStatus,
}: {
  state: ImportState;
  onDismiss: () => void;
  onRestoreAnother: () => void;
  setStatus: SetStatus;
}) {
  const [failuresOpen, setFailuresOpen] = useState(false);
  const focusOnMount = useFocusOnMount();
  const outcome = describeFinish(state);
  const result = state.result;
  const errors = result?.errors ?? [];
  const failures: Failure[] = result?.failures ?? [];

  const rows: Array<[string, number, boolean?]> = result
    ? [
        ['resultTabs', result.tabs],
        ['resultWindows', result.windows],
        ['resultGroups', result.groups],
        ['resultBookmarks', result.bookmarks],
        ['resultTabsSkipped', result.tabsSkipped],
        ['resultBookmarksSkipped', result.bookmarksSkipped],
        ['resultTabsFailed', result.tabsFailed, true],
        ['resultBookmarksFailed', result.bookmarksFailed, true],
      ]
    : [];

  async function copyFailures() {
    const lines = failures.map((f) => [failureKind(f.kind), f.title ?? '', f.url ?? '', failureReason(f.reason)].join('\t'));
    try {
      await copyText(lines.join('\n'));
      setStatus(t('failuresCopied'), TONE.success);
    } catch (error) {
      setStatus(t('copyFailed', messageOf(error)), TONE.error);
    }
  }

  return (
    <>
      <section id="results-card" aria-labelledby="results-title" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <h2 id="results-title" ref={focusOnMount} tabIndex={-1} className="text-sm font-medium outline-none!">
          {t('resultsTitle')}
        </h2>

        {outcome && (
          <ToneAlert id="results-summary" tone={outcome.tone}>
            {outcome.message}
          </ToneAlert>
        )}

        {result && (
          <dl id="results-stats" className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg border bg-card px-3 py-3">
            {rows.map(([labelKey, value, isFailure]) => (
              <div key={labelKey} className="flex items-baseline justify-between gap-2 text-sm">
                <dt className="text-muted-foreground">{t(labelKey)}</dt>
                <dd className={cn('font-semibold tabular-nums', isFailure && value > 0 && 'text-destructive')}>{fmt(value)}</dd>
              </div>
            ))}
          </dl>
        )}

        {errors.length > 0 && (
          <div id="results-errors-wrap" className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">{t('resultsErrorsLabel')}</h3>
            <ul id="results-errors" className="flex list-disc flex-col gap-1 pl-5 text-sm text-destructive">
              {errors.map((message, i) => (
                <li key={i}>{String(message)}</li>
              ))}
            </ul>
          </div>
        )}

        {failures.length > 0 && (
          <Collapsible id="results-failures" open={failuresOpen} onOpenChange={setFailuresOpen} className="rounded-lg border bg-card">
            <CollapsibleTrigger
              id="results-failures-summary"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronRightIcon
                aria-hidden="true"
                className={cn('size-4 text-muted-foreground transition-transform motion-reduce:transition-none', failuresOpen && 'rotate-90')}
              />
              {tp('failuresSummary', failures.length, fmt(failures.length))}
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-3 px-3 pt-1 pb-3">
              <div>
                <Button type="button" id="btn-copy-failures" variant="outline" size="sm" onClick={() => void copyFailures()}>
                  <CopyIcon data-icon="inline-start" />
                  {t('failuresCopy')}
                </Button>
              </div>
              <ScrollArea className="rounded-md border bg-background [&>[data-slot=scroll-area-viewport]]:max-h-52">
                <ul id="results-failures-list" className="flex flex-col divide-y px-2.5">
                  {failures.map((failure, i) => (
                    <li key={i} className="flex flex-col gap-0.5 py-2 text-sm">
                      <span className="truncate font-medium">{failure.title || failure.url || failureKind(failure.kind)}</span>
                      {failure.title && failure.url && <span className="truncate text-xs text-muted-foreground">{failure.url}</span>}
                      <span className="text-xs text-muted-foreground">{failureReason(failure.reason)}</span>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            </CollapsibleContent>
          </Collapsible>
        )}
      </section>

      <div className="grid grid-cols-2 gap-2 border-t bg-background px-4 py-3">
        <Button type="button" id="btn-results-another" variant="outline" size="lg" onClick={onRestoreAnother}>
          {t('resultsRestoreAnother')}
        </Button>
        <Button type="button" id="btn-results-dismiss" size="lg" onClick={onDismiss}>
          {t('resultsDone')}
        </Button>
      </div>
    </>
  );
}
