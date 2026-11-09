/**
 * "Search in": chooses which backups the Backups search covers. A button that shows the choice and opens
 * a menu of checkboxes: All backups, one per snapshot (newest first), and the file loaded in the Import tab.
 * The menu stays open while ticking; at least one source always stays ticked.
 */
import { ChevronDownIcon, ListChecksIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { t, tp } from '@/lib/i18n';
import { FILE_SOURCE_ID, isInScope, scopeSize, toggleAll, toggleSource, type Scope } from '@/lib/search-scope';
import type { SnapshotMeta } from '@/lib/types';
import { dateTimeFormat, fmt, formatDate, REASON_BADGE_KEYS } from '../shared';

interface Props {
  /** Newest first. */
  snapshots: SnapshotMeta[];
  /** Name of the file loaded in the Import tab, if any. */
  fileName: string | null;
  /** Already resolved against the sources (see resolveScope). */
  scope: Scope;
  onChange: (scope: Scope) => void;
}

/** "Quick save title" or the reason, e.g. "Manual". */
export function snapshotKind(meta: SnapshotMeta): string {
  if (meta.reason === 'quick' && meta.scope?.title) return meta.scope.title;
  const key = REASON_BADGE_KEYS[meta.reason];
  return key ? t(key) : String(meta.reason ?? '');
}

export function SearchScopeMenu({ snapshots, fileName, scope, onChange }: Props) {
  const sourceIds = [...snapshots.map((s) => s.id), ...(fileName !== null ? [FILE_SOURCE_ID] : [])];
  const chosen = scopeSize(scope, sourceIds);
  const snapshotsIn = snapshots.filter((s) => isInScope(scope, s.id)).length;
  const fileIn = fileName !== null && isInScope(scope, FILE_SOURCE_ID);

  const base = snapshotsIn === 0 ? t('searchScopeFileOnly') : snapshotsIn === snapshots.length ? t('searchScopeAll') : t('searchScopeSome', [fmt(snapshotsIn), fmt(snapshots.length)]);
  const label = fileIn && snapshotsIn > 0 ? t('searchScopeWithFile', base) : base;

  return (
    // Not modal, like the header menu: a modal menu marks the rest of the page aria-hidden while it is open.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button id="search-scope" type="button" variant="outline" className="max-w-[55%] shrink-0 justify-between" aria-label={t('searchScopeButtonLabel', label)}>
          <ListChecksIcon data-icon="inline-start" />
          <span className="truncate">{label}</span>
          <ChevronDownIcon data-icon="inline-end" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent id="search-scope-menu" align="end" className="max-h-80 w-80 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>{t('searchScopeLabel')}</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          id="scope-all"
          checked={scope === null}
          onSelect={(event) => event.preventDefault()}
          onCheckedChange={(on) => onChange(toggleAll(sourceIds, on))}
        >
          {t('searchScopeAll')}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {snapshots.map((meta) => {
          const on = isInScope(scope, meta.id);
          const date = formatDate(meta.createdAt, dateTimeFormat) ?? '';
          return (
            <DropdownMenuCheckboxItem
              key={meta.id}
              data-scope-id={meta.id}
              checked={on}
              disabled={on && chosen === 1}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(next) => onChange(toggleSource(scope, sourceIds, meta.id, next))}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{date}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {snapshotKind(meta)} · {tp('countTabs', meta.stats?.tabs ?? 0, fmt(meta.stats?.tabs ?? 0))}
                </span>
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
        {fileName !== null && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              id="scope-file"
              checked={fileIn}
              disabled={fileIn && chosen === 1}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(next) => onChange(toggleSource(scope, sourceIds, FILE_SOURCE_ID, next))}
            >
              <span className="truncate">{t('searchLoadedFile', fileName)}</span>
            </DropdownMenuCheckboxItem>
          </>
        )}
        {chosen === 1 && <DropdownMenuLabel className="font-normal">{t('searchScopeLastHint')}</DropdownMenuLabel>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
