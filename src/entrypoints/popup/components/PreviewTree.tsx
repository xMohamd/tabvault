import { useMemo, useState } from 'react';
import { t, tp } from '@/lib/i18n';
import { countWindowTabs, selectedByDefault, type Backup, type BackupTab, type BackupWindow } from '@/lib/schema';
import { dedupKey } from '@/lib/url-utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { fmt } from '../shared';

/** Per window: whether its ungrouped tabs and each group are selected. */
export interface WindowSelection {
  ungrouped: boolean;
  groups: boolean[];
}

/** Everything starts selected, except older Session Buddy history snapshots (see selectedByDefault). */
export const defaultSelection = (data: Backup): WindowSelection[] =>
  data.windows.map((win) => {
    const on = selectedByDefault(win);
    return { ungrouped: on, groups: win.groups.map(() => on) };
  });

/** Tab-level filter: only tabs whose dedupKey is in the set (the result of "Select only matching"). */
export type OnlyUrls = ReadonlySet<string>;

const keep = (tabs: BackupTab[], only?: OnlyUrls): BackupTab[] =>
  only ? tabs.filter((tab) => only.has(dedupKey(tab.url))) : tabs;

export function selectedTabCount(data: Backup, selection: WindowSelection[], only?: OnlyUrls): number {
  return data.windows.reduce((total, win, wi) => {
    const sel = selection[wi];
    if (!sel) return total;
    const grouped = win.groups.reduce((sum, group, gi) => sum + (sel.groups[gi] ? keep(group.tabs, only).length : 0), 0);
    return total + (sel.ungrouped ? keep(win.ungroupedTabs, only).length : 0) + grouped;
  }, 0);
}

/** The backup restricted to what is ticked in the preview (and, if given, to the matching tabs). */
export function selectedData(data: Backup, selection: WindowSelection[], only?: OnlyUrls): Backup {
  const windows: BackupWindow[] = [];
  data.windows.forEach((win, wi) => {
    const sel = selection[wi];
    if (!sel) return;
    const ungroupedTabs = sel.ungrouped ? keep(win.ungroupedTabs, only) : [];
    const groups = win.groups
      .filter((_, gi) => sel.groups[gi])
      .map((group) => (only ? { ...group, tabs: keep(group.tabs, only) } : group))
      .filter((group) => group.tabs.length > 0 || !only);
    if (ungroupedTabs.length === 0 && groups.length === 0) return;
    windows.push({ ...win, ungroupedTabs, groups });
  });
  return { ...data, windows };
}

/** Tabs whose title or address contains every word of `query` (case-insensitive). */
export function findMatchingTabs(data: Backup, query: string): BackupTab[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const matches: BackupTab[] = [];
  for (const win of data.windows) {
    for (const tab of [...win.ungroupedTabs, ...win.groups.flatMap((group) => group.tabs)]) {
      const haystack = `${tab.title ?? ''}\n${tab.url ?? ''}`.toLowerCase();
      if (words.every((word) => haystack.includes(word))) matches.push(tab);
    }
  }
  return matches;
}

/** Ticks every container (ungrouped part or group) that holds at least one of the keys. */
export function selectionForKeys(data: Backup, keys: OnlyUrls): WindowSelection[] {
  const has = (tabs: BackupTab[]) => tabs.some((tab) => keys.has(dedupKey(tab.url)));
  return data.windows.map((win) => ({ ungrouped: has(win.ungroupedTabs), groups: win.groups.map((group) => has(group.tabs)) }));
}

interface RowProps {
  id: string;
  checked: boolean;
  indeterminate?: boolean;
  ariaLabel: string;
  name: string;
  count: number;
  color?: string;
  strong?: boolean;
  onChange: (checked: boolean) => void;
}

function TreeCheckbox({ id, checked, indeterminate = false, ariaLabel, name, count, color, strong, onChange }: RowProps) {
  return (
    <div className="flex items-center gap-2 py-1">
      <Checkbox
        id={id}
        aria-label={ariaLabel}
        checked={indeterminate ? 'indeterminate' : checked}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <Label htmlFor={id} className={cn('min-w-0 flex-1 gap-2', strong ? 'font-medium' : 'font-normal')}>
        {color && <span className="group-dot" data-color={color} aria-hidden="true" />}
        <span className="truncate">{name}</span>
      </Label>
      <span className="text-xs tabular-nums text-muted-foreground" aria-hidden="true">
        {fmt(count)}
      </span>
    </div>
  );
}

interface Props {
  data: Backup;
  selection: WindowSelection[];
  /** A manual change of the ticks; the owner also drops any tab-level filter. */
  onChange: (next: WindowSelection[]) => void;
  /** Active tab-level filter (after "Select only matching"). */
  onlyUrls?: OnlyUrls | null;
  onSelectOnly: (keys: OnlyUrls) => void;
  /** Drops the filter and brings back the ticks from before it. */
  onClearOnly: () => void;
}

function SearchResults({ matches }: { matches: BackupTab[] }) {
  return (
    <ScrollArea className="rounded-md border bg-background [&>[data-slot=scroll-area-viewport]]:max-h-52">
      {/* Focusable so the scrollable list can be scrolled with the keyboard. */}
      <ul
        id="preview-results"
        tabIndex={0}
        aria-label={t('previewResultsLabel')}
        className="flex flex-col rounded-md px-2.5 py-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {matches.map((tab, i) => (
          <li key={i} className="flex min-w-0 flex-col py-1">
            <span className="truncate text-sm">{tab.title || tab.url}</span>
            {tab.title && <span className="truncate text-xs text-muted-foreground">{tab.url}</span>}
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

/** Windows → ungrouped tabs / groups, with tri-state window checkboxes. */
export function PreviewCard({ data, selection, onChange, onlyUrls, onSelectOnly, onClearOnly }: Props) {
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';
  const matches = useMemo(() => findMatchingTabs(data, query), [data, query]);
  const clearSearch = () => {
    setQuery('');
    onClearOnly();
  };
  const update = (wi: number, next: WindowSelection) => onChange(selection.map((sel, i) => (i === wi ? next : sel)));
  const setAll = (value: boolean) => onChange(selection.map((sel) => ({ ungrouped: value, groups: sel.groups.map(() => value) })));

  return (
    <section id="preview-card" className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="preview-title" className="text-sm font-medium">
          {t('previewTitle')}
        </h2>
        <div className="flex items-center gap-1">
          <Button type="button" id="btn-select-all" variant="ghost" size="xs" onClick={() => setAll(true)}>
            {t('previewSelectAll')}
          </Button>
          <Button type="button" id="btn-select-none" variant="ghost" size="xs" onClick={() => setAll(false)}>
            {t('previewSelectNone')}
          </Button>
        </div>
      </div>

      <Input
        id="preview-search"
        type="search"
        value={query}
        autoComplete="off"
        placeholder={t('previewSearchPlaceholder')}
        aria-label={t('previewSearchPlaceholder')}
        onChange={(event) => setQuery(event.target.value)}
      />

      {(searching || onlyUrls) && (
        <div className="flex items-center justify-between gap-2">
          <p id="preview-match-count" role="status" className="text-xs text-muted-foreground">
            {searching ? (matches.length > 0 ? tp('previewMatchCount', matches.length, fmt(matches.length)) : t('previewNoMatches')) : ''}
          </p>
          <div className="flex items-center gap-1">
            {searching && (
              <Button
                type="button"
                id="btn-select-matching"
                variant="secondary"
                size="xs"
                disabled={matches.length === 0}
                onClick={() => onSelectOnly(new Set(matches.map((tab) => dedupKey(tab.url))))}
              >
                {t('previewSelectMatching')}
              </Button>
            )}
            <Button type="button" id="btn-clear-search" variant="ghost" size="xs" onClick={clearSearch}>
              {t('previewClearSearch')}
            </Button>
          </div>
        </div>
      )}

      {searching ? (
        matches.length > 0 && <SearchResults matches={matches} />
      ) : (
        <ScrollArea className="rounded-md border bg-background [&>[data-slot=scroll-area-viewport]]:max-h-52">
          <div id="preview-tree" role="group" aria-labelledby="preview-title" className="px-2.5 py-1.5">
            {data.windows.map((win, wi) => {
              const sel = selection[wi];
              if (!sel) return null;
              const number = fmt(wi + 1);
              const windowTabs = countWindowTabs(win);
              const hasUngrouped = win.ungroupedTabs.length > 0;
              const states = [...(hasUngrouped ? [sel.ungrouped] : []), ...sel.groups];
              const checkedCount = states.filter(Boolean).length;

              return (
                <div key={wi} className="flex flex-col">
                  <TreeCheckbox
                    id={`pv-w${wi}`}
                    strong
                    checked={checkedCount === states.length}
                    indeterminate={checkedCount > 0 && checkedCount < states.length}
                    ariaLabel={
                      win.title
                        ? tp('previewWindowTitledLabel', windowTabs, [win.title, fmt(windowTabs)])
                        : tp('previewWindowLabel', windowTabs, [number, fmt(windowTabs)])
                    }
                    name={win.title || t('previewWindow', number)}
                    count={windowTabs}
                    onChange={(value) => update(wi, { ungrouped: value, groups: sel.groups.map(() => value) })}
                  />
                  <div className="flex flex-col pl-6">
                    {hasUngrouped && (
                      <TreeCheckbox
                        id={`pv-w${wi}-u`}
                        checked={sel.ungrouped}
                        ariaLabel={tp('previewUngroupedLabel', win.ungroupedTabs.length, [number, fmt(win.ungroupedTabs.length)])}
                        name={t('previewUngrouped')}
                        count={win.ungroupedTabs.length}
                        onChange={(value) => update(wi, { ...sel, ungrouped: value })}
                      />
                    )}
                    {win.groups.map((group, gi) => {
                      const title = group.title || t('previewUntitledGroup');
                      return (
                        <TreeCheckbox
                          key={gi}
                          id={`pv-w${wi}-g${gi}`}
                          checked={sel.groups[gi] === true}
                          ariaLabel={tp('previewGroupLabel', group.tabs.length, [title, number, fmt(group.tabs.length)])}
                          name={title}
                          count={group.tabs.length}
                          color={group.color}
                          onChange={(value) => update(wi, { ...sel, groups: sel.groups.map((g, i) => (i === gi ? value : g)) })}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}

      <p id="preview-total" role="status" className="text-xs text-muted-foreground">
        {onlyUrls
          ? tp('previewRestoringMatching', selectedTabCount(data, selection, onlyUrls), fmt(selectedTabCount(data, selection, onlyUrls)))
          : t('previewSelected', fmt(selectedTabCount(data, selection)))}
      </p>
    </section>
  );
}
