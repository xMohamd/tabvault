/**
 * Search inside the loaded backup (Import tab). While the box has text, the matches replace the
 * preview tree and each can be ticked: the review then restores just the ticked ones.
 */
import type { Dispatch, SetStateAction } from 'react';
import { Input } from '@/components/ui/input';
import { t, tp } from '@/lib/i18n';
import type { SearchResult } from '@/lib/types';
import { fmt } from '../shared';
import { SearchResults, type Picked } from './SearchResults';

interface Props {
  query: string;
  onQueryChange: (query: string) => void;
  /** Matches of the current query, already limited to the kinds that will be restored. */
  results: SearchResult[];
  picked: Picked;
  onPickedChange: Dispatch<SetStateAction<Map<string, SearchResult>>>;
  /** The All / Tabs / Bookmarks filter is only useful when both kinds can be found. */
  showFilter: boolean;
}

export function ImportSearch({ query, onQueryChange, results, picked, onPickedChange, showFilter }: Props) {
  const searching = query.trim() !== '';
  return (
    <section id="import-search" className="flex flex-col gap-2">
      <Input
        id="preview-search"
        type="search"
        value={query}
        autoComplete="off"
        placeholder={t('previewSearchPlaceholder')}
        aria-label={t('previewSearchPlaceholder')}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query) {
            event.preventDefault();
            onQueryChange('');
          }
        }}
      />
      {searching && (
        <div className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-3">
          {results.length > 0 && (
            <p id="preview-match-count" role="status" className="text-xs text-muted-foreground">
              {tp('searchResultsCount', results.length, fmt(results.length))}
            </p>
          )}
          <SearchResults
            idPrefix="preview"
            results={results}
            picked={picked}
            onPickedChange={onPickedChange}
            emptyDescription={t('searchNoMatchesFileHint', query.trim())}
            showSources={false}
            showFilter={showFilter}
            scrollable
          />
        </div>
      )}
    </section>
  );
}
