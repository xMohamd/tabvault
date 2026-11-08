/**
 * Search results across the chosen backups (and the file loaded in the Import tab).
 *
 * Replaces the snapshot list while the search box is not empty. Ticked results become a small
 * backup that is loaded into the Import tab, so the usual preview and restore options apply.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { send } from '@/lib/messaging';
import { t, tp } from '@/lib/i18n';
import type { Backup } from '@/lib/schema';
import { FILE_SOURCE_ID } from '@/lib/search-scope';
import { backupFromResults, DEFAULT_SEARCH_LIMIT, mergeSearchResults, searchBackups } from '@/lib/snapshot-search';
import type { SearchResult } from '@/lib/types';
import { errorDetail, fmt, TONE, type SetStatus } from '../shared';
import { resultId, SearchResults } from './SearchResults';

/** The loaded file is searched without a cap; the merged list is capped afterwards. */
const FILE_LIMIT = 100_000;

export interface LoadedFile {
  data: Backup;
  name: string;
}

/** What a search covers: these snapshots (undefined = all of them), and the loaded file or not. */
export interface SearchScope {
  ids: string[] | undefined;
  file: boolean;
}

interface Background {
  results: SearchResult[];
  total: number;
  searched: number;
  available: number;
}

interface Props {
  /** Trimmed, debounced query (never empty). */
  query: string;
  scope: SearchScope;
  loadedFile: LoadedFile | null;
  restoreRunning: boolean;
  setStatus: SetStatus;
  /** The ticked results as a backup to offer in the Import tab. */
  onRestore: (data: Backup, count: number) => void;
}

const SEP = '\n';

export function BackupSearch({ query, scope, loadedFile, restoreRunning, setStatus, onRestore }: Props) {
  const idsKey = scope.ids ? scope.ids.join(SEP) : null;
  const requestKey = `${query}${SEP}${SEP}${idsKey ?? '*'}`;
  const [response, setResponse] = useState<{ key: string; value: Background } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  /** Ticks survive refining the query and changing the scope, so they hold the results themselves. */
  const [selected, setSelected] = useState<Map<string, SearchResult>>(new Map());
  const request = useRef(0);

  useEffect(() => {
    const mine = ++request.current;
    const ids = idsKey === null ? undefined : idsKey === '' ? [] : idsKey.split(SEP);
    void send('SEARCH_SNAPSHOTS', { query, limit: DEFAULT_SEARCH_LIMIT, ...(ids ? { ids } : {}) }).then((reply) => {
      if (mine !== request.current) return; // A newer search is already on its way.
      if (reply.ok) {
        setResponse({ key: requestKey, value: { results: reply.results, total: reply.total, searched: reply.searched, available: reply.available } });
        setError(null);
      } else {
        setError({ key: requestKey, message: errorDetail(reply) });
      }
    });
  }, [query, idsKey, requestKey]);

  const searchedFile = scope.file && loadedFile !== null;
  const fileResults = useMemo(
    () =>
      loadedFile && scope.file
        ? searchBackups(
            [{ id: FILE_SOURCE_ID, label: t('searchLoadedFile', loadedFile.name), date: loadedFile.data.exportedAt, data: loadedFile.data }],
            query,
            { limit: FILE_LIMIT },
          ).results
        : [],
    [loadedFile, scope.file, query],
  );

  const background = response?.key === requestKey ? response.value : null;
  const failed = error?.key === requestKey ? error.message : null;
  const merged = useMemo(() => {
    if (!background) return null;
    const results = mergeSearchResults([background.results, fileResults], DEFAULT_SEARCH_LIMIT);
    // Matches the background cut off still count towards the total.
    const hidden = background.total - background.results.length;
    const total = mergeSearchResults([background.results, fileResults], Number.MAX_SAFE_INTEGER).length + hidden;
    return {
      results,
      total,
      searched: background.searched + (searchedFile ? 1 : 0),
      available: background.available + (loadedFile ? 1 : 0),
    };
  }, [background, fileResults, searchedFile, loadedFile]);

  function restore() {
    if (restoreRunning) {
      setStatus(t('importBusy'), TONE.warning);
      return;
    }
    // In the order shown, not the order ticked.
    const chosen = (merged?.results ?? []).filter((r) => selected.has(resultId(r)));
    const rest = [...selected.entries()].filter(([id]) => !chosen.some((r) => resultId(r) === id)).map(([, r]) => r);
    onRestore(backupFromResults([...chosen, ...rest], t('searchBookmarksFolder')), selected.size);
  }

  const capped = merged !== null && merged.total > merged.results.length;

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-2 pb-4">
        {failed ? (
          <p id="search-error" role="alert" className="text-sm text-destructive">
            {t('searchFailed', failed)}
          </p>
        ) : merged === null ? (
          <div id="search-loading" className="flex flex-col gap-2" aria-busy="true">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : (
          <>
            {merged.total > 0 && (
              <p id="search-summary" role="status" className="text-sm text-muted-foreground">
                {summary(merged.total, merged.searched, merged.available)}
                {capped && ` ${t('searchCapped', fmt(merged.results.length))}`}
              </p>
            )}
            <SearchResults
              idPrefix="search"
              results={merged.results}
              picked={selected}
              onPickedChange={setSelected}
              emptyDescription={t('searchNoMatchesHint', query)}
            />
          </>
        )}
      </div>

      <div className="border-t bg-background px-4 py-3">
        <Button id="btn-restore-selected" size="lg" className="w-full" disabled={selected.size === 0} onClick={restore}>
          <RotateCcwIcon data-icon="inline-start" />
          {selected.size === 0 ? t('searchSelectToRestore') : t('searchRestoreSelected', fmt(selected.size))}
        </Button>
      </div>
    </>
  );
}

/** "12 results in 3 of 7 backups", "12 results in all 7 backups" or "12 results in 1 backup". */
function summary(total: number, searched: number, available: number): string {
  const results = tp('searchResultsCount', total, fmt(total));
  if (searched < available) return t('searchSummaryPart', [results, fmt(searched), fmt(available)]);
  if (available > 1) return t('searchSummaryAll', [results, fmt(available)]);
  return t('searchSummary', [results, tp('searchBackupsCount', searched, fmt(searched))]);
}
