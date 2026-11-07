/**
 * Search across several backups at once. Pure: no extension APIs.
 *
 * Matching rule (same as the in-backup search in the preview): every whitespace-separated word
 * must appear, case-insensitively, in the title or the address. Pages are deduplicated by
 * kind + dedupKey(url); a result lists every source it appears in and takes its details
 * (title, group, folder...) from the newest of them.
 */
import { emptyBackup, type Backup, type BackupGroup, type BackupTab, type BookmarkNode, type GroupColor } from './schema';
import type { SearchResult, SearchSource } from './types';
import { dedupKey } from './url-utils';

export interface SearchInput {
  id: string;
  label: string;
  date: string | null;
  data: Backup;
}

export interface SearchOptions {
  /** Most results returned (default 500); `total` still counts every match. */
  limit?: number;
  kinds?: Array<'tab' | 'bookmark'>;
}

export const DEFAULT_SEARCH_LIMIT = 500;

/** Missing or unparseable dates sort as oldest. */
const stamp = (date: string | null): number => {
  const ms = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
};

export const searchWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

const matches = (words: string[], title: string, url: string): boolean => {
  const haystack = `${title}\n${url}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
};

interface Entry {
  result: SearchResult;
  /** Timestamp of the source the details came from. */
  detailsAt: number;
  seen: Set<string>;
}

export function searchBackups(
  sources: SearchInput[],
  query: string,
  { limit = DEFAULT_SEARCH_LIMIT, kinds = ['tab', 'bookmark'] }: SearchOptions = {},
): { results: SearchResult[]; total: number } {
  const words = searchWords(query);
  if (words.length === 0) return { results: [], total: 0 };

  // Per kind: entries by dedupKey, plus a shortcut by the exact address. The same pages recur in every
  // snapshot, so most lookups are one hit in `byUrl` and the address is parsed only once.
  const entries = { tab: new Map<string, Entry>(), bookmark: new Map<string, Entry>() };
  const byUrl = { tab: new Map<string, Entry>(), bookmark: new Map<string, Entry>() };

  type Details = Omit<SearchResult, 'key' | 'sources' | 'latest'>;
  /** `build` runs only when the details are needed: the common repeat in an older snapshot costs a lookup. */
  const add = (source: SearchInput, kind: SearchResult['kind'], url: string, build: () => Details) => {
    const at = stamp(source.date);
    let entry = byUrl[kind].get(url);
    if (!entry) {
      const key = dedupKey(url);
      entry = entries[kind].get(key);
      if (!entry) {
        const ref: SearchSource = { id: source.id, label: source.label, date: source.date };
        entry = { result: { ...build(), key, sources: [ref], latest: source.date }, detailsAt: at, seen: new Set([source.id]) };
        entries[kind].set(key, entry);
        byUrl[kind].set(url, entry);
        return;
      }
      byUrl[kind].set(url, entry);
    }
    if (!entry.seen.has(source.id)) {
      entry.seen.add(source.id);
      entry.result.sources.push({ id: source.id, label: source.label, date: source.date });
    }
    if (at > entry.detailsAt) {
      entry.detailsAt = at;
      entry.result = { ...build(), key: entry.result.key, sources: entry.result.sources, latest: source.date };
    }
  };

  for (const source of sources) {
    if (kinds.includes('tab')) {
      for (const win of source.data?.windows ?? []) {
        const visit = (tab: BackupTab, group?: { title: string; color: GroupColor }) => {
          if (!tab || typeof tab.url !== 'string' || !matches(words, tab.title ?? '', tab.url)) return;
          add(source, 'tab', tab.url, () => ({
            kind: 'tab',
            url: tab.url,
            title: tab.title ?? '',
            ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
            ...(tab.pinned ? { pinned: true } : {}),
            ...(group ? { group } : {}),
            ...(tab.container ? { container: tab.container } : {}),
          }));
        };
        for (const tab of win.ungroupedTabs ?? []) visit(tab);
        for (const group of win.groups ?? []) {
          const info = { title: group.title ?? '', color: group.color };
          for (const tab of group.tabs ?? []) visit(tab, info);
        }
      }
    }
    if (kinds.includes('bookmark')) {
      const walk = (node: BookmarkNode, path: string[], depth: number) => {
        if (!node || depth > 100) return;
        if (node.url) {
          if (matches(words, node.title ?? '', node.url)) {
            add(source, 'bookmark', node.url, () => ({ kind: 'bookmark', url: node.url!, title: node.title ?? '', folderPath: path }));
          }
          return;
        }
        // The tree root has an empty title and is left out of the path.
        const next = depth === 0 && !node.title ? path : [...path, node.title ?? ''];
        for (const child of node.children ?? []) walk(child, next, depth + 1);
      };
      for (const node of source.data?.bookmarks ?? []) walk(node, [], 0);
    }
  }

  const all = [...entries.tab.values(), ...entries.bookmark.values()].map(({ result }) => {
    result.sources.sort((a, b) => stamp(b.date) - stamp(a.date));
    return result;
  });
  all.sort((a, b) => stamp(b.latest) - stamp(a.latest) || (a.title || a.url).localeCompare(b.title || b.url));
  return { results: all.slice(0, Math.max(0, limit)), total: all.length };
}

/** Merges result lists by kind + key: sources are combined, details come from the newer side. */
export function mergeSearchResults(lists: SearchResult[][], limit = DEFAULT_SEARCH_LIMIT): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  for (const result of lists.flat()) {
    const id = `${result.kind}\n${result.key}`;
    const current = merged.get(id);
    if (!current) {
      merged.set(id, { ...result, sources: [...result.sources] });
      continue;
    }
    const known = new Set(current.sources.map((s) => s.id));
    const sources = [...current.sources, ...result.sources.filter((s) => !known.has(s.id))];
    sources.sort((a, b) => stamp(b.date) - stamp(a.date));
    const newer = stamp(result.latest) > stamp(current.latest) ? result : current;
    merged.set(id, { ...newer, sources, latest: newer.latest });
  }
  const all = [...merged.values()];
  all.sort((a, b) => stamp(b.latest) - stamp(a.latest) || (a.title || a.url).localeCompare(b.title || b.url));
  return all.slice(0, limit);
}

/**
 * A backup holding just the chosen results, ready for the normal import preview:
 * tabs in one window (grouped again by title + color, pinned tabs kept pinned),
 * bookmarks in a plain top-level folder that the bookmark importer puts under Other Bookmarks.
 */
export function backupFromResults(results: SearchResult[], bookmarksFolder: string): Backup {
  const data = emptyBackup({ format: 'search-results' });
  const ungroupedTabs: BackupTab[] = [];
  const groups = new Map<string, BackupGroup>();
  const bookmarks: BookmarkNode[] = [];

  for (const result of results) {
    if (result.kind === 'bookmark') {
      bookmarks.push({ title: result.title, url: result.url });
      continue;
    }
    const tab: BackupTab = {
      url: result.url,
      title: result.title,
      pinned: result.pinned === true,
      ...(result.favIconUrl ? { favIconUrl: result.favIconUrl } : {}),
      ...(result.container ? { container: result.container } : {}),
    };
    // Browsers do not allow pinned tabs inside a group.
    if (!result.group || tab.pinned) {
      ungroupedTabs.push(tab);
      continue;
    }
    const id = `${result.group.color}\n${result.group.title}`;
    const group = groups.get(id) ?? { title: result.group.title, color: result.group.color, collapsed: false, tabs: [] };
    group.tabs.push(tab);
    groups.set(id, group);
  }

  if (ungroupedTabs.length > 0 || groups.size > 0) data.windows.push({ ungroupedTabs, groups: [...groups.values()] });
  if (bookmarks.length > 0) data.bookmarks.push({ title: bookmarksFolder, children: bookmarks });
  return data;
}
