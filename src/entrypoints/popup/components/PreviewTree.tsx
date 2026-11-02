import { t, tp } from '@/lib/i18n';
import { countWindowTabs, type Backup, type BackupWindow } from '@/lib/schema';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { fmt } from '../shared';

/** Per window: whether its ungrouped tabs and each group are selected. */
export interface WindowSelection {
  ungrouped: boolean;
  groups: boolean[];
}

export const defaultSelection = (data: Backup): WindowSelection[] =>
  data.windows.map((win) => ({ ungrouped: true, groups: win.groups.map(() => true) }));

export function selectedTabCount(data: Backup, selection: WindowSelection[]): number {
  return data.windows.reduce((total, win, wi) => {
    const sel = selection[wi];
    if (!sel) return total;
    const grouped = win.groups.reduce((sum, group, gi) => sum + (sel.groups[gi] ? group.tabs.length : 0), 0);
    return total + (sel.ungrouped ? win.ungroupedTabs.length : 0) + grouped;
  }, 0);
}

/** The backup restricted to what is ticked in the preview. */
export function selectedData(data: Backup, selection: WindowSelection[]): Backup {
  const windows: BackupWindow[] = [];
  data.windows.forEach((win, wi) => {
    const sel = selection[wi];
    if (!sel) return;
    const ungroupedTabs = sel.ungrouped ? win.ungroupedTabs : [];
    const groups = win.groups.filter((_, gi) => sel.groups[gi]);
    if (ungroupedTabs.length === 0 && groups.length === 0) return;
    windows.push({ ...win, ungroupedTabs, groups });
  });
  return { ...data, windows };
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
  onChange: (next: WindowSelection[]) => void;
}

/** Windows → ungrouped tabs / groups, with tri-state window checkboxes. */
export function PreviewCard({ data, selection, onChange }: Props) {
  const update = (wi: number, next: WindowSelection) => onChange(selection.map((sel, i) => (i === wi ? next : sel)));
  const setAll = (value: boolean) => onChange(selection.map((sel) => ({ ungrouped: value, groups: sel.groups.map(() => value) })));

  return (
    <section id="preview-card" className="flex flex-col gap-2 rounded-lg border bg-card px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id="preview-title" className="text-sm font-medium">
          {t('previewTitle')}
        </h3>
        <div className="flex items-center gap-1">
          <Button type="button" id="btn-select-all" variant="ghost" size="xs" onClick={() => setAll(true)}>
            {t('previewSelectAll')}
          </Button>
          <Button type="button" id="btn-select-none" variant="ghost" size="xs" onClick={() => setAll(false)}>
            {t('previewSelectNone')}
          </Button>
        </div>
      </div>

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
                  ariaLabel={tp('previewWindowLabel', windowTabs, [number, fmt(windowTabs)])}
                  name={t('previewWindow', number)}
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

      <p id="preview-total" role="status" className="text-xs text-muted-foreground">
        {t('previewSelected', fmt(selectedTabCount(data, selection)))}
      </p>
    </section>
  );
}
