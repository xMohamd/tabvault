import { t, tp } from '@/lib/i18n';
import { countWindowTabs, type Backup, type BackupWindow } from '@/lib/schema';
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
  checked: boolean;
  indeterminate?: boolean;
  ariaLabel: string;
  name: string;
  count: number;
  color?: string;
  onChange: (checked: boolean) => void;
}

function TreeCheckbox({ checked, indeterminate = false, ariaLabel, name, count, color, onChange }: RowProps) {
  return (
    <label className="checkbox-simple tree-row">
      <input
        type="checkbox"
        className="control-input"
        aria-label={ariaLabel}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        // `indeterminate` exists only as a DOM property.
        ref={(input) => {
          if (input) input.indeterminate = indeterminate;
        }}
      />
      <span className="checkmark-sm" aria-hidden="true" />
      {color && <span className="group-dot" data-color={color} aria-hidden="true" />}
      <span className="tree-name">{name}</span>
      <span className="tree-count" aria-hidden="true">
        {fmt(count)}
      </span>
    </label>
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
    <div className="card" id="preview-card">
      <div className="card-head">
        <h3 className="section-label" id="preview-title">
          {t('previewTitle')}
        </h3>
        <div className="mini-actions">
          <button type="button" id="btn-select-all" className="btn-link" onClick={() => setAll(true)}>
            {t('previewSelectAll')}
          </button>
          <button type="button" id="btn-select-none" className="btn-link" onClick={() => setAll(false)}>
            {t('previewSelectNone')}
          </button>
        </div>
      </div>
      <div id="preview-tree" className="tree" role="group" aria-labelledby="preview-title">
        <ul>
          {data.windows.map((win, wi) => {
            const sel = selection[wi];
            if (!sel) return null;
            const number = fmt(wi + 1);
            const windowTabs = countWindowTabs(win);
            const hasUngrouped = win.ungroupedTabs.length > 0;
            const states = [...(hasUngrouped ? [sel.ungrouped] : []), ...sel.groups];
            const checkedCount = states.filter(Boolean).length;

            return (
              <li className="tree-window" key={wi}>
                <TreeCheckbox
                  checked={checkedCount === states.length}
                  indeterminate={checkedCount > 0 && checkedCount < states.length}
                  ariaLabel={tp('previewWindowLabel', windowTabs, [number, fmt(windowTabs)])}
                  name={t('previewWindow', number)}
                  count={windowTabs}
                  onChange={(value) => update(wi, { ungrouped: value, groups: sel.groups.map(() => value) })}
                />
                <ul className="tree-children">
                  {hasUngrouped && (
                    <li>
                      <TreeCheckbox
                        checked={sel.ungrouped}
                        ariaLabel={tp('previewUngroupedLabel', win.ungroupedTabs.length, [number, fmt(win.ungroupedTabs.length)])}
                        name={t('previewUngrouped')}
                        count={win.ungroupedTabs.length}
                        onChange={(value) => update(wi, { ...sel, ungrouped: value })}
                      />
                    </li>
                  )}
                  {win.groups.map((group, gi) => {
                    const title = group.title || t('previewUntitledGroup');
                    return (
                      <li key={gi}>
                        <TreeCheckbox
                          checked={sel.groups[gi] === true}
                          ariaLabel={tp('previewGroupLabel', group.tabs.length, [title, number, fmt(group.tabs.length)])}
                          name={title}
                          count={group.tabs.length}
                          color={group.color}
                          onChange={(value) => update(wi, { ...sel, groups: sel.groups.map((g, i) => (i === gi ? value : g)) })}
                        />
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ul>
      </div>
      <p id="preview-total" className="field-hint" role="status">
        {t('previewSelected', fmt(selectedTabCount(data, selection)))}
      </p>
    </div>
  );
}
