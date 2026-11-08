/**
 * The list of search results with per-result checkboxes, shared by the Backups search and the search
 * inside a loaded file (Import tab): All / Tabs / Bookmarks filter with counts, Select all / Clear
 * selection, the rows, and the empty state. The owner holds the ticks (they survive a changed query).
 */
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { SearchXIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t, tp } from '@/lib/i18n';
import type { SearchResult } from '@/lib/types';
import { fmt, formatDate } from '../shared';

type Filter = 'all' | 'tabs' | 'bookmarks';
const KIND_OF: Record<Exclude<Filter, 'all'>, SearchResult['kind']> = { tabs: 'tab', bookmarks: 'bookmark' };
const MAX_LISTED_SOURCES = 8;

/** Ticks are kept by this id: the same page as a tab and as a bookmark are two results. */
export const resultId = (result: SearchResult): string => `${result.kind}\n${result.key}`;

export type Picked = ReadonlyMap<string, SearchResult>;

interface Props {
  /** Prefix of the element ids: `search` (Backups tab) or `preview` (Import tab). */
  idPrefix: 'search' | 'preview';
  results: SearchResult[];
  picked: Picked;
  /** A state setter: ticks are changed with updater functions, so several clicks in one tick all count. */
  onPickedChange: Dispatch<SetStateAction<Map<string, SearchResult>>>;
  /** Hint under "No matches". */
  emptyDescription: string;
  /** Lists the backups that contain each result (pointless for a single file). Default true. */
  showSources?: boolean;
  /** The All / Tabs / Bookmarks filter. Default true. */
  showFilter?: boolean;
  /** Keeps the list in its own scroll area instead of growing the page. */
  scrollable?: boolean;
}

export function SearchResults({ idPrefix, results, picked, onPickedChange, emptyDescription, showSources = true, showFilter = true, scrollable = false }: Props) {
  const [filter, setFilter] = useState<Filter>('all');

  const counts = useMemo(() => {
    const tabs = results.filter((r) => r.kind === 'tab').length;
    return { all: results.length, tabs, bookmarks: results.length - tabs };
  }, [results]);
  const visible = useMemo(() => results.filter((r) => filter === 'all' || r.kind === KIND_OF[filter]), [results, filter]);

  if (results.length === 0) {
    return (
      <Empty id={`${idPrefix}-empty`} className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchXIcon />
          </EmptyMedia>
          <EmptyTitle>{t('searchNoMatches')}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const allVisiblePicked = visible.length > 0 && visible.every((r) => picked.has(resultId(r)));
  const toggle = (result: SearchResult, checked: boolean) =>
    onPickedChange((current) => {
      const next = new Map(current);
      if (checked) next.set(resultId(result), result);
      else next.delete(resultId(result));
      return next;
    });

  const list = (
    <ul id={`${idPrefix}-results`} aria-label={t('searchResultsLabel')} className="flex flex-col gap-1.5">
      {visible.map((result) => (
        <ResultRow key={resultId(result)} result={result} showSources={showSources} checked={picked.has(resultId(result))} onChange={(checked) => toggle(result, checked)} />
      ))}
    </ul>
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {showFilter && (
          <ToggleGroup
            id={`${idPrefix}-filter`}
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
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button
            id={`btn-${idPrefix}-select-all`}
            type="button"
            variant="ghost"
            size="sm"
            disabled={visible.length === 0 || allVisiblePicked}
            onClick={() => onPickedChange((current) => new Map([...current, ...visible.map((r): [string, SearchResult] => [resultId(r), r])]))}
          >
            {t('searchSelectAll')}
          </Button>
          <Button id={`btn-${idPrefix}-clear`} type="button" variant="ghost" size="sm" disabled={picked.size === 0} onClick={() => onPickedChange(new Map())}>
            {t('searchClearSelection')}
          </Button>
        </div>
      </div>
      {scrollable ? (
        <ScrollArea className="rounded-md [&>[data-slot=scroll-area-viewport]]:max-h-72">{list}</ScrollArea>
      ) : (
        list
      )}
    </>
  );
}

function ResultRow({ result, checked, showSources, onChange }: { result: SearchResult; checked: boolean; showSources: boolean; onChange: (checked: boolean) => void }) {
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
          {showSources && (
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
          )}
        </div>
      </div>
    </li>
  );
}
