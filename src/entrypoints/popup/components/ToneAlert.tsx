/** An Alert coloured by outcome tone (error / warning / success), with a matching icon. */
import type { ComponentProps, ReactNode } from 'react';
import { CircleAlertIcon, CircleCheckIcon, TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import { TONE, type Tone } from '../shared';

const ICONS = { [TONE.error]: CircleAlertIcon, [TONE.warning]: TriangleAlertIcon, [TONE.success]: CircleCheckIcon } as const;

const TONE_CLASS: Record<Tone, string> = {
  [TONE.error]: '',
  [TONE.warning]: 'text-warning *:data-[slot=alert-description]:text-warning/90',
  [TONE.success]: 'text-success *:data-[slot=alert-description]:text-success/90',
};

export function ToneAlert({
  tone,
  children,
  className,
  ...props
}: { tone: Tone; children: ReactNode } & Omit<ComponentProps<typeof Alert>, 'variant' | 'children'>) {
  const Icon = ICONS[tone];
  return (
    <Alert variant={tone === TONE.error ? 'destructive' : 'default'} className={cn(TONE_CLASS[tone], className)} {...props}>
      <Icon />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
