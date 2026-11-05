/** Result of comparing two snapshots: summary chips plus collapsible added/removed lists. */
import { ArrowLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { t } from '@/lib/i18n';
import { isEmptyDiff, type BackupDiff } from '@/lib/snapshot-diff';
import { cn } from '@/lib/utils';
import { fmt } from '../shared';

interface Entry {
  title: string;
  url?: string;
}

interface Props {
  /** Formatted dates, older first. */
  from: string;
  to: string;
  diff: BackupDiff;
  onBack: () => void;
}

function ChangeList({ id, label, entries, tone }: { id: string; label: string; entries: Entry[]; tone: 'added' | 'removed' }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <Collapsible id={id} open={open} onOpenChange={setOpen} className="rounded-lg border bg-card">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden="true"
          className={cn('size-4 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')}
        />
        <span className={cn('flex-1', tone === 'removed' && 'text-destructive')}>{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-1.5 px-3 pt-1 pb-3">
          {entries.map((entry, i) => (
            <li key={`${entry.url ?? entry.title}-${i}`} className="min-w-0 text-xs">
              <div className="truncate font-medium" title={entry.title}>
                {entry.title || entry.url}
              </div>
              {entry.url && entry.title && entry.title !== entry.url && (
                <div className="truncate text-muted-foreground" title={entry.url}>
                  {entry.url}
                </div>
              )}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SnapshotCompare({ from, to, diff, onBack }: Props) {
  const { tabs, groups, bookmarks } = diff;
  const empty = isEmptyDiff(diff);
  const groupEntries = (titles: string[]): Entry[] => titles.map((title) => ({ title }));
  const bookmarkEntries = (nodes: typeof bookmarks.added): Entry[] => nodes.map((n) => ({ title: n.title, url: n.url }));

  return (
    <div id="snapshot-compare" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button id="compare-back" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeftIcon data-icon="inline-start" />
          {t('compareBack')}
        </Button>
      </div>
      <h2 id="compare-title" className="text-sm font-medium">
        {t('compareTitle', [from, to])}
      </h2>

      {empty ? (
        <Empty id="compare-empty" className="border">
          <EmptyHeader>
            <EmptyTitle>{t('compareNone')}</EmptyTitle>
            <EmptyDescription>{t('compareUnchangedTabs', fmt(tabs.kept))}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <ul id="compare-summary" className="flex flex-wrap gap-1.5">
            {tabs.added.length > 0 && (
              <li>
                <Badge variant="secondary">{t('compareChipTabsAdded', fmt(tabs.added.length))}</Badge>
              </li>
            )}
            {tabs.removed.length > 0 && (
              <li>
                <Badge variant="outline">{t('compareChipTabsRemoved', fmt(tabs.removed.length))}</Badge>
              </li>
            )}
            {groups.added.length + groups.removed.length > 0 && (
              <li>
                <Badge variant="secondary">{t('compareChipGroups', [fmt(groups.added.length), fmt(groups.removed.length)])}</Badge>
              </li>
            )}
            {bookmarks.added.length + bookmarks.removed.length > 0 && (
              <li>
                <Badge variant="secondary">
                  {t('compareChipBookmarks', [fmt(bookmarks.added.length), fmt(bookmarks.removed.length)])}
                </Badge>
              </li>
            )}
          </ul>
          <div className="flex flex-col gap-2">
            <ChangeList id="cmp-tabs-added" tone="added" label={t('compareAddedTabs', fmt(tabs.added.length))} entries={tabs.added} />
            <ChangeList id="cmp-tabs-removed" tone="removed" label={t('compareRemovedTabs', fmt(tabs.removed.length))} entries={tabs.removed} />
            <ChangeList id="cmp-groups-added" tone="added" label={t('compareAddedGroups', fmt(groups.added.length))} entries={groupEntries(groups.added)} />
            <ChangeList id="cmp-groups-removed" tone="removed" label={t('compareRemovedGroups', fmt(groups.removed.length))} entries={groupEntries(groups.removed)} />
            <ChangeList id="cmp-bookmarks-added" tone="added" label={t('compareAddedBookmarks', fmt(bookmarks.added.length))} entries={bookmarkEntries(bookmarks.added)} />
            <ChangeList id="cmp-bookmarks-removed" tone="removed" label={t('compareRemovedBookmarks', fmt(bookmarks.removed.length))} entries={bookmarkEntries(bookmarks.removed)} />
          </div>
          <p className="text-xs text-muted-foreground">{t('compareUnchangedTabs', fmt(tabs.kept))}</p>
        </>
      )}
    </div>
  );
}
