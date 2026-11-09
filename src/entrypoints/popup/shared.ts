/** Small helpers and constants shared by the popup components. */
import { t } from '@/lib/i18n';

export type Tone = 'is-error' | 'is-success' | 'is-warning';
export const TONE = { error: 'is-error', success: 'is-success', warning: 'is-warning' } as const satisfies Record<string, Tone>;

export interface Message {
  text: string;
  tone?: Tone;
}
export type SetStatus = (text: string, tone?: Tone) => void;

export const TAB_ORDER = ['export', 'import', 'backups'] as const;
export type TabName = (typeof TAB_ORDER)[number];

export const MANY_TABS_THRESHOLD = 200;
export const KEEP_MIN = 1;
export const KEEP_MAX = 50;
export const CONFIRM_RESET_MS = 4000;

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;

/** Message key of the label for each snapshot reason. */
export const REASON_BADGE_KEYS: Record<string, string> = {
  scheduled: 'reasonScheduled',
  manual: 'reasonManual',
  quick: 'reasonQuick',
  'pre-replace': 'reasonPreReplace',
};

export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ');

// --- Formatting ---

const numberFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
export const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const kbFormat = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'kilobyte', maximumFractionDigits: 0 });
const mbFormat = new Intl.NumberFormat(undefined, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1 });

export const fmt = (value: number | null | undefined): string => numberFormat.format(value ?? 0);

export function formatDate(input: unknown, formatter: Intl.DateTimeFormat = dateFormat): string | null {
  if (input === null || input === undefined || input === '') return null;
  const date = new Date(input as string | number);
  return Number.isNaN(date.getTime()) ? null : formatter.format(date);
}

export function formatSize(bytes: number | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
  return bytes >= BYTES_PER_MB ? mbFormat.format(bytes / BYTES_PER_MB) : kbFormat.format(Math.max(1, bytes / BYTES_PER_KB));
}

/** Text of a failed reply (or transport failure). */
export function errorDetail(response: unknown): string {
  return (response as { error?: string } | null | undefined)?.error || t('errorUnknown');
}

export const messageOf = (error: unknown): string => (error instanceof Error && error.message) || t('errorUnknown');

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function tabFromHash(): TabName | null {
  const name = location.hash.replace(/^#/, '');
  return (TAB_ORDER as readonly string[]).includes(name) ? (name as TabName) : null;
}
