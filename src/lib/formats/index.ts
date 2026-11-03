/**
 * Format detection and conversion of other tools' export files to the native backup format.
 */

import { BackupFormatError, emptyBackup, normalizeBackup, type Backup } from '../schema';
import { assertSize, isObject, TabBudget, makeTab, markTruncated } from './common';
import { convertOneTab, looksLikeOneTab } from './onetab';
import { convertSessionBuddy, isSessionBuddyBackup, looksLikeSessionBuddy } from './session-buddy';
import { convertNetscapeHtml, looksLikeNetscapeHtml } from './netscape-html';
import { convertFirefoxBookmarks, looksLikeFirefoxBookmarks } from './firefox-bookmarks';

export type BackupFormat =
  | 'native'
  | 'onetab'
  | 'session-buddy'
  | 'netscape-html'
  | 'firefox-bookmarks-json'
  | 'url-list';

export interface ParseContext {
  filename?: string;
  /** Provided by the UI as (html) => new DOMParser().parseFromString(html, 'text/html'). */
  parseHtml?: (html: string) => Document;
}

export interface ParsedBackup {
  data: Backup;
  format: BackupFormat;
  label: string;
}

/**
 * A native backup has bookmarks, a schemaVersion, or windows in the native shape.
 * Bare `{ windows: [{ tabs }] }` is treated as a (single) Session Buddy session instead.
 */
export function looksNative(json: unknown): boolean {
  if (!isObject(json)) return false;
  if (Array.isArray(json.bookmarks)) return true;
  if (!Array.isArray(json.windows)) return false;
  if (typeof json.schemaVersion === 'string') return true;
  const objs = (json.windows as unknown[]).filter(isObject);
  if (objs.some((w) => Array.isArray(w.ungroupedTabs))) return true;
  return !objs.some((w) => Array.isArray(w.tabs));
}

/** Plain list of URLs, one per line; only http/https lines are kept. */
export function convertUrlList(text: string): Backup | null {
  const budget = new TabBudget();
  const tabs = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^https?:\/\/\S+$/i.test(line)) continue;
    const tab = makeTab(line, '', budget);
    if (tab) tabs.push(tab);
  }
  if (tabs.length === 0) return null;
  const backup = emptyBackup({ format: 'url-list', browser: 'unknown' });
  backup.windows.push({ ungroupedTabs: tabs, groups: [] });
  markTruncated(backup, budget);
  return backup;
}

/** Wraps normalisation and rejects results with nothing usable. */
function finish(raw: unknown): Backup {
  const { data } = normalizeBackup(raw);
  if (data.windows.length === 0 && data.bookmarks.length === 0) {
    throw new BackupFormatError('The file contains nothing usable.');
  }
  return data;
}

/**
 * Detects the file format and converts it to a native backup object.
 * @throws {BackupFormatError} when the format is unrecognised or the file contains nothing usable
 */
export function parseBackupFile(text: string, ctx: ParseContext = {}): ParsedBackup {
  if (typeof text !== 'string') throw new BackupFormatError('File contents must be text.');
  assertSize(text);
  const body = text.replace(/^﻿/, '').trim();
  if (body === '') throw new BackupFormatError('The file is empty.');

  if (body.startsWith('{') || body.startsWith('[')) {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new BackupFormatError('The file looks like JSON but could not be parsed.');
    }
    if (looksNative(json)) return { data: finish(json), format: 'native', label: 'Native backup' };
    if (looksLikeFirefoxBookmarks(json)) {
      return {
        data: finish(convertFirefoxBookmarks(json)),
        format: 'firefox-bookmarks-json',
        label: 'Firefox bookmarks backup',
      };
    }
    if (looksLikeSessionBuddy(json)) {
      const label = isSessionBuddyBackup(json) ? 'Session Buddy backup' : 'Session Buddy export';
      return { data: finish(convertSessionBuddy(json)), format: 'session-buddy', label };
    }
    throw new BackupFormatError('Unrecognised JSON format.');
  }

  if (looksLikeNetscapeHtml(body)) {
    return { data: finish(convertNetscapeHtml(body, ctx)), format: 'netscape-html', label: 'Bookmarks HTML export' };
  }

  if (looksLikeOneTab(body)) {
    return { data: finish(convertOneTab(body)), format: 'onetab', label: 'OneTab export' };
  }

  const list = convertUrlList(body);
  if (list) return { data: finish(list), format: 'url-list', label: 'URL list' };

  throw new BackupFormatError('Unrecognised file format: no tabs, bookmarks or URLs were found.');
}
