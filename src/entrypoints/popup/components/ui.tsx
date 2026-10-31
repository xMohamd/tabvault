/** Presentational building blocks that mirror the reference markup (and therefore its CSS). */
import type { ChangeEventHandler, ReactNode } from 'react';
import { cx, fmt, type Tone } from '../shared';

/** Inline message strip. Stays mounted (it is a live region); an empty message hides it. */
export function Hint({
  text,
  tone,
  className,
  id,
  live = true,
}: {
  text?: string | null;
  tone?: Tone;
  className?: string;
  id?: string;
  live?: boolean;
}) {
  return (
    <p id={id} className={cx('inline-hint', tone, className, !text && 'hidden')} role={live ? 'status' : undefined}>
      {text ?? ''}
    </p>
  );
}

interface CheckProps {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}

const onCheck =
  (cb: (checked: boolean) => void): ChangeEventHandler<HTMLInputElement> =>
  (event) =>
    cb(event.target.checked);

/** Small checkbox used in option lists. */
export function CheckboxSimple({ id, checked, disabled, onChange, children }: CheckProps) {
  return (
    <label className="checkbox-simple">
      <input type="checkbox" id={id} className="control-input" checked={checked} disabled={disabled} onChange={onCheck(onChange)} />
      <span className="checkmark-sm" aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}

/** Large checkbox with a primary (and optional secondary) line. */
export function CheckboxWrap({
  id,
  checked,
  onChange,
  primary,
  secondary,
  compact,
  hidden,
}: Omit<CheckProps, 'children'> & { primary: string; secondary?: string; compact?: boolean; hidden?: boolean }) {
  return (
    <label className={cx('checkbox-wrap', compact && 'compact', hidden && 'hidden')}>
      <input type="checkbox" id={id} className="control-input" checked={checked} onChange={onCheck(onChange)} />
      <span className="checkbox-custom" aria-hidden="true" />
      {secondary === undefined ? (
        <span className="primary">{primary}</span>
      ) : (
        <span className="label-text">
          <span className="primary">{primary}</span>
          <span className="secondary">{secondary}</span>
        </span>
      )}
    </label>
  );
}

/** "Label 12" pair; label first so it reads right for 1 as well as many. */
export function Stat({ value, label }: { value: number; label: string }) {
  return (
    <span className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{fmt(value)}</span>
    </span>
  );
}

export function Panel({
  name,
  active,
  children,
}: {
  name: 'export' | 'import' | 'backups';
  active: boolean;
  children: ReactNode;
}) {
  return (
    <section id={`${name}-panel`} className={cx('panel', active && 'active')} role="tabpanel" aria-labelledby={`tab-${name}`} hidden={!active}>
      {children}
    </section>
  );
}

export function PanelIntro({ title, text }: { title: string; text: string }) {
  return (
    <div className="panel-intro">
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
