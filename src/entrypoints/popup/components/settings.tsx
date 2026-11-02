/** Building blocks for settings-style panels (switch rows, collapsible sections). */
import { useState, type ReactNode } from 'react';
import { ChevronRightIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** A labelled switch: title (+ optional description) on the left, switch on the right. */
export function SwitchRow({
  id,
  label,
  description,
  checked,
  disabled,
  onChange,
  inset,
}: {
  id: string;
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  /** Indented: refines the row above it. */
  inset?: boolean;
}) {
  return (
    <Field orientation="horizontal" data-disabled={disabled || undefined} className={cn(inset && 'pl-6')}>
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {description && <FieldDescription>{description}</FieldDescription>}
      </FieldContent>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </Field>
  );
}

/** A collapsed-by-default section whose header shows a one-glance summary. */
export function SettingsSection({
  id,
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible id={id} open={open} onOpenChange={setOpen} className="rounded-lg border bg-card">
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden="true"
          className={cn('size-4 text-muted-foreground transition-transform motion-reduce:transition-none', open && 'rotate-90')}
        />
        <span className="flex-1">{title}</span>
        {summary && (
          <Badge variant="secondary" className="max-w-40 truncate font-normal">
            {summary}
          </Badge>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 px-3 pt-1 pb-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}
