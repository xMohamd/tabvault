/**
 * Search results across every saved backup (and the file loaded in the Import tab).
 *
 * Replaces the snapshot list while the search box is not empty. Ticked results become a small
 * backup that is loaded into the Import tab, so the usual preview and restore options apply.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcwIcon, SearchXIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { send } from '@/lib/messaging';
import { t, tp } from '@/lib/i18n';
import type { Backup } from '@/lib/schema';
import { backupFromResults, DEFAULT_SEARCH_LIMIT, mergeSearchResults, searchBackups } from '@/lib/snapshot-search';
import type { SearchResult } from '@/lib/types';
import { errorDetail, fmt, formatDate, TONE, type SetStatus } from '../shared';

type Filter = 'all' | 'tabs' | 'bookmarks';
const KIND_OF: Record<Exclude<Filter, 'all'>, SearchResult['kind']> = { tabs: 'tab', bookmarks: 'bookmark' };
const MAX_LISTED_SOURCES = 8;
/** The loaded file is searched without a cap; the merged list is capped afterwards. */
const FILE_LIMIT = 100_000;
const FILE_SOURCE_ID = 'loaded-file';

const idOf = (result: SearchResult) => `${result.kind}\n${result.key}`;

export interface LoadedFile {
  data: Backup;
  name: string;
}

interface Background {
  results: SearchResult[];
  total: number;
  searched: number;
}

interface Props {
  /** Trimmed, debounced query (never empty). */
  query: string;
  loadedFile: LoadedFile | null;
  restoreRunning: boolean;
  setStatus: SetStatus;
  /** The ticked results as a backup to offer in the Import tab. */
  onRestore: (data: Backup, count: number) => void;
}

export function BackupSearch({ query, loadedFile, restoreRunning, setStatus, onRestore }: Props) {
  const [response, setResponse] = useState<{ query: string; value: Background } | null>(null);
  const [error, setError] = useState<{ query: string; message: string } | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  /** Ticks survive refining the query, so they hold the results themselves. */
  const [selected, setSelected] = useState<Map<string, SearchResult>>(new Map());
  const request = useRef(0);

  useEffect(() => {
    const mine = ++request.current;
    void send('SEARCH_SNAPSHOTS', { query, limit: DEFAULT_SEARCH_LIMIT }).then((reply) => {
      if (mine !== request.current) return; // A newer query is already on its way.
      if (reply.ok) {
        setResponse({ query, value: { results: reply.results, total: reply.total, searched: reply.searched } });
        setError(null);
      } else {
        setError({ query, message: errorDetail(reply) });
      }
    });
  }, [query]);

  const fileResults = useMemo(
    () =>
      loadedFile
        ? searchBackups(
            [{ id: FILE_SOURCE_ID, label: t('searchLoadedFile', loadedFile.name), date: loadedFile.data.exportedAt, data: loadedFile.data }],
            query,
            { limit: FILE_LIMIT },
          ).results
        : [],
    [loadedFile, query],
  );

  const background = response?.query === query ? response.value : null;
  const failed = error?.query === query ? error.message : null;
  const merged = useMemo(() => {
    if (!background) return null;
    const results = mergeSearchResults([background.results, fileResults], DEFAULT_SEARCH_LIMIT);
    // Matches the background cut off still count towards the total.
    const hidden = background.total - background.results.length;
    const total = mergeSearchResults([background.results, fileResults], Number.MAX_SAFE_INTEGER).length + hidden;
    return { results, total, searched: background.searched + (loadedFile ? 1 : 0) };
  }, [background, fileResults, loadedFile]);

  const counts = useMemo(() => {
    const list = merged?.results ?? [];
    const tabs = list.filter((r) => r.kind === 'tab').length;
    return { all: list.length, tabs, bookmarks: list.length - tabs };
  }, [merged]);
  const visible = useMemo(
    () => (merged?.results ?? []).filter((r) => filter === 'all' || r.kind === KIND_OF[filter]),
    [merged, filter],
  );

  function toggle(result: SearchResult, checked: boolean) {
    setSelected((current) => {
      const next = new Map(current);
      if (checked) next.set(idOf(result), result);
      else next.delete(idOf(result));
      return next;
    });
  }

  function restore() {
    if (restoreRunning) {
      setStatus(t('importBusy'), TONE.warning);
      return;
    }
    // In the order shown, not the order ticked.
    const chosen = (merged?.results ?? []).filter((r) => selected.has(idOf(r)));
    const rest = [...selected.entries()].filter(([id]) => !chosen.some((r) => idOf(r) === id)).map(([, r]) => r);
    onRestore(backupFromResults([...chosen, ...rest], t('searchBookmarksFolder')), selected.size);
  }

  const capped = merged !== null && merged.total > merged.results.length;
  const allVisibleSelected = visible.length > 0 && visible.every((r) => selected.has(idOf(r)));

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
        ) : merged.total === 0 ? (
          <Empty id="search-empty" className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchXIcon />
              </EmptyMedia>
              <EmptyTitle>{t('searchNoMatches')}</EmptyTitle>
              <EmptyDescription>{t('searchNoMatchesHint', query)}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <p id="search-summary" role="status" className="text-sm text-muted-foreground">
              {t('searchSummary', [tp('searchResultsCount', merged.total, fmt(merged.total)), tp('searchBackupsCount', merged.searched, fmt(merged.searched))])}
              {capped && ` ${t('searchCapped', fmt(merged.results.length))}`}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                id="search-filter"
                type="single"
                variant="outline"
                size="sm"
                spacing={0}
                aria-label={t('searchFilterLabel')}
                value={filter}
                // Radix reports '' when the active item is clicked again; one filter is always on.
                onValueChange={(value) => value && setFilter(value as Filter)}
              >
                <ToggleGroupItem value="all">{t('searchFilterAll', fmt(counts.all))}</ToggleGroupItem>
                <ToggleGroupItem value="tabs">{t('searchFilterTabs', fmt(counts.tabs))}</ToggleGroupItem>
                <ToggleGroupItem value="bookmarks">{t('searchFilterBookmarks', fmt(counts.bookmarks))}</ToggleGroupItem>
              </ToggleGroup>
              <div className="ml-auto flex items-center gap-1">
                <Button id="btn-search-select-all" variant="ghost" size="sm" disabled={visible.length === 0 || allVisibleSelected} onClick={() => setSelected((c) => new Map([...c, ...visible.map((r): [string, SearchResult] => [idOf(r), r])]))}>
                  {t('searchSelectAll')}
                </Button>
                <Button id="btn-search-clear" variant="ghost" size="sm" disabled={selected.size === 0} onClick={() => setSelected(new Map())}>
                  {t('searchClearSelection')}
                </Button>
              </div>
            </div>
            <ul id="search-results" aria-label={t('searchResultsLabel')} className="flex flex-col gap-1.5">
              {visible.map((result) => (
                <ResultRow key={idOf(result)} result={result} checked={selected.has(idOf(result))} onChange={(checked) => toggle(result, checked)} />
              ))}
            </ul>
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

function ResultRow({ result, checked, onChange }: { result: SearchResult; checked: boolean; onChange: (checked: boolean) => void }) {
  const name = result.title || result.url;
  const latest = formatDate(result.latest);
  const shown = result.sources.slice(0, MAX_LISTED_SOURCES).map((s) => s.label);
  const more = result.sources.length - shown.length;
  const list = more > 0 ? [...shown, t('searchSourcesMore', fmt(more))] : shown;
  const where = tp('searchInBackups', result.sources.length, [fmt(result.sources.length), latest ?? '']);
  const place = result.kind === 'bookmark' && result.folderPath?.length ? result.folderPath.join(' / ') : null;

  return (
    <li className="flex items-start gap-2.5 rounded-lg border px-3 py-2">
      <Checkbox className="mt-0.5" checked={checked} aria-label={name} onCheckedChange={(value) => onChange(value === true)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{name}</span>
        {result.title && <span className="truncate text-xs text-muted-foreground">{result.url}</span>}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {result.group && (
            <span className="flex min-w-0 items-center gap-1.5" aria-label={t('searchRowGroup', result.group.title || t('previewUntitledGroup'))}>
              <span className="group-dot" data-color={result.group.color} aria-hidden="true" />
              <span className="truncate">{result.group.title || t('previewUntitledGroup')}</span>
            </span>
          )}
          {result.pinned && <span>{t('searchResultPinned')}</span>}
          {place && <span className="truncate">{place}</span>}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="rounded-sm tabular-nums underline decoration-dotted underline-offset-2 outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-label={t('searchSourcesLabel', [where, list.join('; ')])}>
                {where}
              </button>
            </TooltipTrigger>
            <TooltipContent className="flex max-w-64 flex-col gap-0.5">
              {list.map((label, i) => (
                <span key={i}>{label}</span>
              ))}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </li>
  );
}
