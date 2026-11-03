/**
 * Shared helpers for the format converters. Pure functions, no browser APIs.
 */

import { BackupFormatError, type Backup, type BackupTab } from '../schema';
import { unwrapPlaceholderUrl } from '../url-utils';

/** Maximum accepted input size, in characters. */
export const MAX_TEXT_LENGTH = 50 * 1024 * 1024;
/** Maximum number of tabs a converter will emit. */
export const MAX_TABS = 20000;

const TAB_URL_RE = /^(?:https?|ftp|file):/i;
/**
 * Browser pages some browsers can reopen (e.g. chrome://settings in Chromium). They are kept
 * so the restore step can decide per browser and list what it couldn't reopen, instead of
 * silently dropping them here. Script and data URLs are never tabs.
 */
const BROWSER_PAGE_RE = /^(?:chrome|edge|brave|opera|vivaldi|about):/i;

export const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Throws if the text is too large to process. */
export function assertSize(text: string): void {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new BackupFormatError('File is too large to import (limit is 50 MB).');
  }
}

/** Counts how many tabs may still be emitted. */
export class TabBudget {
  left: number;
  truncated = false;

  constructor(limit: number = MAX_TABS) {
    this.left = limit;
  }

  /** @returns true if one more tab may be added. */
  take(): boolean {
    if (this.left <= 0) {
      this.truncated = true;
      return false;
    }
    this.left--;
    return true;
  }
}

/** Whether the URL may become a restorable tab. */
export function isTabUrl(url: unknown): url is string {
  return typeof url === 'string' && TAB_URL_RE.test(url.trim());
}

/** Builds a native tab, or null when the URL is not allowed or the budget is exhausted. */
export interface MakeTabOptions {
  /** Also keep browser pages (chrome://, about:, ...); used for structured tab exports. */
  allowBrowserPages?: boolean;
}

/**
 * Builds a tab, or null if the URL can't be a tab. Suspended-tab placeholders
 * (tab suspender extensions' park/suspended pages) are unwrapped to the real address;
 * the placeholder is kept in metadata.originalUrl.
 */
export function makeTab(
  url: unknown,
  title: unknown,
  budget: TabBudget,
  pinned = false,
  options: MakeTabOptions = {},
): BackupTab | null {
  if (typeof url !== 'string') return null;
  const original = url.trim();
  const real = unwrapPlaceholderUrl(original);
  const usable = isTabUrl(real) || (options.allowBrowserPages === true && BROWSER_PAGE_RE.test(real));
  if (!usable) return null;
  if (!budget.take()) return null;
  const tab: BackupTab = {
    url: real,
    title: typeof title === 'string' ? title.trim() : '',
    pinned: pinned === true,
  };
  if (real !== original) tab.metadata = { originalUrl: original };
  return tab;
}

/** Marks a raw backup as truncated when the tab cap was hit. */
export function markTruncated(backup: Backup, budget: TabBudget): void {
  if (budget.truncated) backup.source.truncated = true;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the common HTML entities. */
export function decodeEntities(s: string): string {
  return s.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g,
    (m: string, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (dec !== undefined || hex !== undefined) {
        const code = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? '', 16);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      const key = (name ?? '').toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? (NAMED_ENTITIES[key] ?? m) : m;
    },
  );
}
