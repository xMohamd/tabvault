/**
 * Session Buddy JSON converter, following the documented format
 * (https://www.sessionbuddy.com/formats/#json) and checked against a real v4 backup.
 *
 * Accepted shapes:
 *  - v4 backup:  { format: "nxs.json.v2", collections?: Collection[], history?: HistoryEntry[] }
 *  - export / object forms: { collections | sessions | folders | windows | links | tabs: [...] }
 *  - array forms: Collection[] | Folder[] | Link[]
 *
 * Collection/Session: { title?, name?, created?, updated?, folders? | windows? }  ("name" wins over "title")
 * Folder/Window:      { title?, name?, state?, left?, top?, width?, height?, incognito?, type?, links? | tabs? }
 * Link/Tab:           { url, title?, favIconUrl?, pinned?, active?, groupId? }
 * HistoryEntry (v4 backup only): { type: "browser-closed" | ..., created?, instant?, windows: Window[] }
 *
 * Session Buddy stores a tab's groupId but no group names or colors, so tabs sharing
 * a groupId become an untitled group with an automatically assigned color. Legacy
 * files that do carry `groups`/`tabGroups` definitions keep their titles and colors.
 */

import {
  emptyBackup,
  BackupFormatError,
  GROUP_COLORS,
  normalizeColor,
  WINDOW_STATES,
  type Backup,
  type BackupGroup,
  type BackupTab,
  type BackupWindow,
  type WindowState,
} from '../schema';
import { TabBudget, makeTab, markTruncated, isObject } from './common';

type Obj = Record<string, unknown>;

/** Session Buddy v4 backups declare their format like "nxs.json.v2". */
const BACKUP_FORMAT_PREFIX = 'nxs.';
const MAX_TITLE_LENGTH = 200;
/** Embedded data: icons can be huge; only web favicons are worth keeping. */
const WEB_FAVICON = /^https?:\/\//i;
const historyDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const objects = (v: unknown): Obj[] => asArray(v).filter(isObject);

/** "name" overrides "title", as documented. */
function titleOf(o: Obj): string {
  const raw = typeof o.name === 'string' && o.name.trim() ? o.name : o.title;
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_TITLE_LENGTH) : '';
}

const finite = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
const isGroupId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function toTab(link: Obj, budget: TabBudget): BackupTab | null {
  const tab = makeTab(link.url, link.title, budget, link.pinned === true, { allowBrowserPages: true });
  if (!tab) return null;
  if (link.active === true) tab.active = true;
  if (typeof link.favIconUrl === 'string' && WEB_FAVICON.test(link.favIconUrl)) tab.favIconUrl = link.favIconUrl;
  return tab;
}

/** Group definitions, only present in some legacy files. */
function groupDefinitions(folder: Obj): Map<number, Obj> {
  const defs = new Map<number, Obj>();
  for (const g of objects(folder.groups ?? folder.tabGroups)) {
    if (isGroupId(g.id)) defs.set(g.id, g);
  }
  return defs;
}

/** A folder/window object (or a bare list of links) as one native window. */
function toWindow(folder: Obj, budget: TabBudget, title = titleOf(folder)): BackupWindow | null {
  const links = objects(folder.links ?? folder.tabs);
  const defs = groupDefinitions(folder);
  const grouped = links.some((l) => isGroupId(l.groupId));

  const win: BackupWindow = { ungroupedTabs: [], groups: [] };
  const groups = new Map<number, BackupGroup>();
  links.forEach((link, position) => {
    const tab = toTab(link, budget);
    if (!tab) return;
    // With groups, positions let the importer interleave grouped and ungrouped tabs as they were.
    if (grouped) tab.index = position;
    if (!isGroupId(link.groupId) || tab.pinned) {
      win.ungroupedTabs.push(tab);
      return;
    }
    let group = groups.get(link.groupId);
    if (!group) {
      const def = defs.get(link.groupId);
      group = {
        title: def ? titleOf(def) : '',
        color: def ? normalizeColor(def.color) : (GROUP_COLORS[groups.size % GROUP_COLORS.length] ?? 'grey'),
        collapsed: def?.collapsed === true,
        tabs: [],
      };
      groups.set(link.groupId, group);
      win.groups.push(group);
    }
    group.tabs.push(tab);
  });
  if (win.ungroupedTabs.length === 0 && win.groups.length === 0) return null;

  if (title) win.title = title;
  if (WINDOW_STATES.includes(folder.state as WindowState)) win.state = folder.state as WindowState;
  for (const key of ['left', 'top', 'width', 'height'] as const) {
    const value = finite(folder[key]);
    if (value !== undefined) win[key] = value;
  }
  return win;
}

/** Windows of a collection/session: one per folder, plus any links placed directly on it. */
function collectionWindows(collection: Obj, budget: TabBudget): BackupWindow[] {
  const name = titleOf(collection);
  const folders = objects(collection.folders ?? collection.windows);
  const out = folders.map((folder, i) => {
    const folderName = titleOf(folder);
    // "Work" collection with folders "Docs" and "Mail" -> "Work · Docs", "Work · Mail".
    const title = [name, folderName || (folders.length > 1 ? `${i + 1}` : '')].filter(Boolean).join(' · ');
    return toWindow(folder, budget, title);
  });
  if (Array.isArray(collection.links) || Array.isArray(collection.tabs)) out.push(toWindow(collection, budget, name));
  return out.filter((w): w is BackupWindow => w !== null);
}

const closedAt = (entry: Obj): number | undefined => finite(entry.created) ?? finite(entry.instant);

/**
 * One history entry (a snapshot of all windows when the browser closed), titled with its date.
 * `snapshot` ranks entries newest first: 0 is the newest; the preview pre-selects only that one,
 * because older snapshots mostly repeat the same tabs.
 */
function historyWindows(entry: Obj, budget: TabBudget, snapshot: number): BackupWindow[] {
  const when = closedAt(entry);
  const date = when !== undefined ? historyDate.format(new Date(when)) : '';
  return objects(entry.windows)
    .map((w, i, all) => {
      const win = toWindow(w, budget, [date, all.length > 1 ? `${i + 1}` : ''].filter(Boolean).join(' · '));
      if (win) win.metadata = { sessionBuddy: 'history', snapshot, ...(when !== undefined ? { closedAt: when } : {}) };
      return win;
    })
    .filter((w): w is BackupWindow => w !== null);
}

/** History entries newest first (by close time; entries without a time keep their file order, last). */
function newestFirst(entries: Obj[]): Obj[] {
  return entries
    .map((entry, order) => ({ entry, order, when: closedAt(entry) }))
    .sort((a, b) => (b.when ?? -Infinity) - (a.when ?? -Infinity) || a.order - b.order)
    .map(({ entry }) => entry);
}

/** What kind of objects an array holds (documented array forms). */
function arrayKind(items: unknown[]): 'collections' | 'folders' | 'links' | null {
  const first = items.find(isObject);
  if (!first) return null;
  if (Array.isArray(first.folders) || Array.isArray(first.windows)) return 'collections';
  if (Array.isArray(first.links) || Array.isArray(first.tabs)) return 'folders';
  if (typeof first.url === 'string') return 'links';
  return null;
}

/** Whether the parsed JSON looks like Session Buddy data (backup, export or any documented form). */
export function looksLikeSessionBuddy(json: unknown): boolean {
  if (Array.isArray(json)) return arrayKind(json) !== null;
  if (!isObject(json)) return false;
  if (typeof json.format === 'string' && json.format.startsWith(BACKUP_FORMAT_PREFIX)) return true;
  return ['collections', 'sessions', 'history', 'folders', 'windows', 'links', 'tabs'].some((key) => Array.isArray(json[key]));
}

/** True for a v4 backup file (as opposed to an export). */
export function isSessionBuddyBackup(json: unknown): boolean {
  return isObject(json) && ((typeof json.format === 'string' && json.format.startsWith(BACKUP_FORMAT_PREFIX)) || Array.isArray(json.history));
}

/**
 * Converts parsed Session Buddy JSON to a (not yet normalised) native backup.
 * Saved collections come first, then history snapshots, newest first.
 * @throws {BackupFormatError} when no restorable tab is found
 */
export function convertSessionBuddy(json: unknown): Backup {
  const budget = new TabBudget();
  const windows: BackupWindow[] = [];

  if (Array.isArray(json)) {
    const kind = arrayKind(json);
    const items = objects(json);
    if (kind === 'collections') items.forEach((c) => windows.push(...collectionWindows(c, budget)));
    if (kind === 'folders') items.forEach((f) => windows.push(...[toWindow(f, budget)].filter((w): w is BackupWindow => w !== null)));
    if (kind === 'links') windows.push(...[toWindow({ links: items }, budget)].filter((w): w is BackupWindow => w !== null));
  } else if (isObject(json)) {
    for (const c of objects(json.collections ?? json.sessions)) windows.push(...collectionWindows(c, budget));
    newestFirst(objects(json.history)).forEach((h, rank) => windows.push(...historyWindows(h, budget, rank)));
    for (const f of objects(json.folders ?? json.windows)) {
      const win = toWindow(f, budget);
      if (win) windows.push(win);
    }
    if (Array.isArray(json.links) || Array.isArray(json.tabs)) {
      const win = toWindow(json, budget, '');
      if (win) windows.push(win);
    }
  }

  if (windows.length === 0) throw new BackupFormatError('No tabs found in the Session Buddy file.');
  const backup = emptyBackup({ format: 'session-buddy', browser: 'unknown' });
  backup.windows = windows;
  markTruncated(backup, budget);
  return backup;
}
