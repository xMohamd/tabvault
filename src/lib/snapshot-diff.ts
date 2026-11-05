/**
 * Pure comparison of two backups (older → newer). Tabs and URL bookmarks are matched
 * by dedupKey, so a repeated URL counts once; groups are matched by title.
 */
import type { Backup, BackupTab, BookmarkNode } from './schema';
import { dedupKey } from './url-utils';

export interface BackupDiff {
  tabs: { added: BackupTab[]; removed: BackupTab[]; kept: number };
  groups: { added: string[]; removed: string[] };
  bookmarks: { added: BookmarkNode[]; removed: BookmarkNode[] };
}

function uniqueTabs(backup: Backup): Map<string, BackupTab> {
  const map = new Map<string, BackupTab>();
  for (const win of backup.windows ?? []) {
    for (const tab of [...(win.ungroupedTabs ?? []), ...(win.groups ?? []).flatMap((g) => g.tabs ?? [])]) {
      const key = dedupKey(tab.url);
      if (key && !map.has(key)) map.set(key, tab);
    }
  }
  return map;
}

function groupTitles(backup: Backup): Set<string> {
  const titles = new Set<string>();
  for (const win of backup.windows ?? []) {
    for (const group of win.groups ?? []) {
      const title = group.title?.trim();
      if (title) titles.add(title);
    }
  }
  return titles;
}

function uniqueBookmarks(nodes: BookmarkNode[] | undefined, map = new Map<string, BookmarkNode>()): Map<string, BookmarkNode> {
  for (const node of nodes ?? []) {
    if (node.url) {
      const key = dedupKey(node.url);
      if (key && !map.has(key)) map.set(key, node);
    }
    if (node.children) uniqueBookmarks(node.children, map);
  }
  return map;
}

function split<T>(older: Map<string, T>, newer: Map<string, T>) {
  const added: T[] = [];
  const removed: T[] = [];
  let kept = 0;
  for (const [key, item] of newer) {
    if (older.has(key)) kept++;
    else added.push(item);
  }
  for (const [key, item] of older) if (!newer.has(key)) removed.push(item);
  return { added, removed, kept };
}

export function diffBackups(older: Backup, newer: Backup): BackupDiff {
  const tabs = split(uniqueTabs(older), uniqueTabs(newer));
  const oldGroups = groupTitles(older);
  const newGroups = groupTitles(newer);
  const bookmarks = split(uniqueBookmarks(older.bookmarks), uniqueBookmarks(newer.bookmarks));
  return {
    tabs,
    groups: {
      added: [...newGroups].filter((title) => !oldGroups.has(title)),
      removed: [...oldGroups].filter((title) => !newGroups.has(title)),
    },
    bookmarks: { added: bookmarks.added, removed: bookmarks.removed },
  };
}

export const isEmptyDiff = (diff: BackupDiff): boolean =>
  diff.tabs.added.length + diff.tabs.removed.length + diff.groups.added.length + diff.groups.removed.length +
    diff.bookmarks.added.length + diff.bookmarks.removed.length === 0;
