/**
 * Session Buddy JSON converter. The exact schema is not formally documented, so several
 * shapes are accepted defensively:
 *  - legacy:  { sessions: [{ name?, windows: [{ tabs: [{ url, title, pinned? }] }] }] }
 *  - single:  { windows: [...] }
 *  - v4:      { collections: [{ title?, folders?: [{ links: [{ url, title }] }], links?, windows? }] }
 */

import { emptyBackup, BackupFormatError, normalizeColor, type Backup, type BackupGroup, type BackupWindow } from '../schema';
import { TabBudget, makeTab, markTruncated, isObject } from './common';

/** Converts a list of raw tab-like entries (and optional group info) into a native window. */
function buildWindow(rawTabs: unknown, rawGroups: unknown, budget: TabBudget): BackupWindow | null {
  if (!Array.isArray(rawTabs)) return null;
  const groupInfo = new Map<unknown, Record<string, unknown>>();
  if (Array.isArray(rawGroups)) {
    for (const g of rawGroups) {
      if (isObject(g) && g.id !== undefined && g.id !== null) groupInfo.set(g.id, g);
    }
  }
  const hasGrouping = rawTabs.some((t) => isObject(t) && t.groupId !== undefined && groupInfo.has(t.groupId));

  const win: BackupWindow = { ungroupedTabs: [], groups: [] };
  const groupByKey = new Map<unknown, BackupGroup>();
  rawTabs.forEach((raw: unknown, position) => {
    if (!isObject(raw)) return;
    const tab = makeTab(raw.url, raw.title, budget, raw.pinned === true);
    if (!tab) return;
    if (hasGrouping) tab.index = position;
    const info = groupInfo.get(raw.groupId);
    if (info) {
      let group = groupByKey.get(info.id);
      if (!group) {
        group = {
          title: typeof info.title === 'string' ? info.title : '',
          color: normalizeColor(info.color),
          collapsed: info.collapsed === true,
          tabs: [],
        };
        groupByKey.set(info.id, group);
        win.groups.push(group);
      }
      group.tabs.push(tab);
    } else {
      win.ungroupedTabs.push(tab);
    }
  });
  if (win.ungroupedTabs.length === 0 && win.groups.length === 0) return null;
  return win;
}

/** Extracts a window from a window-like object. */
function windowFrom(w: unknown, budget: TabBudget): BackupWindow | null {
  if (!isObject(w)) return null;
  return buildWindow(w.tabs ?? w.links, w.groups ?? w.tabGroups, budget);
}

/** Extracts windows from a session or collection object. */
function windowsFromSession(session: unknown, budget: TabBudget): BackupWindow[] {
  if (!isObject(session)) return [];
  const out: BackupWindow[] = [];
  const push = (w: BackupWindow | null): void => {
    if (w) out.push(w);
  };
  if (Array.isArray(session.windows)) session.windows.forEach((w: unknown) => push(windowFrom(w, budget)));
  if (Array.isArray(session.folders)) session.folders.forEach((f: unknown) => push(windowFrom(f, budget)));
  if (Array.isArray(session.links)) push(buildWindow(session.links, null, budget));
  if (out.length === 0 && Array.isArray(session.tabs)) push(buildWindow(session.tabs, session.groups, budget));
  return out;
}

/** Whether the parsed JSON looks like a Session Buddy export. */
export function looksLikeSessionBuddy(json: unknown): boolean {
  if (Array.isArray(json)) {
    return json.some(
      (s: unknown) =>
        isObject(s) && (Array.isArray(s.windows) || Array.isArray(s.links) || Array.isArray(s.folders)),
    );
  }
  if (!isObject(json)) return false;
  return Array.isArray(json.sessions) || Array.isArray(json.collections) || Array.isArray(json.windows);
}

/**
 * Converts a parsed Session Buddy export to a (not yet normalised) native backup object.
 * @throws {BackupFormatError}
 */
export function convertSessionBuddy(json: unknown): Backup {
  const budget = new TabBudget();
  let sessions: unknown[] = [];
  if (Array.isArray(json)) sessions = json;
  else if (isObject(json)) {
    if (Array.isArray(json.sessions)) sessions = json.sessions;
    else if (Array.isArray(json.collections)) sessions = json.collections;
    else sessions = [json];
  }
  const windows = sessions.flatMap((s) => windowsFromSession(s, budget));
  if (windows.length === 0) throw new BackupFormatError('No tabs found in the Session Buddy export.');
  const backup = emptyBackup({ format: 'session-buddy', browser: 'unknown' });
  backup.windows = windows;
  markTruncated(backup, budget);
  return backup;
}
