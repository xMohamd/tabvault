/**
 * Firefox bookmarks "Backup…" JSON converter.
 */

import { emptyBackup, BackupFormatError, type Backup, type BookmarkNode } from '../schema';
import { assertSize, isObject } from './common';

const FOLDER_TYPES: Record<string, string> = {
  toolbarFolder: 'bookmarks-bar',
  unfiledBookmarksFolder: 'other',
  mobileFolder: 'mobile',
};

const MAX_DEPTH = 100;

/** Whether the parsed JSON is a Firefox bookmarks backup. */
export function looksLikeFirefoxBookmarks(json: unknown): boolean {
  return (
    isObject(json) &&
    Array.isArray(json.children) &&
    (json.type === 'text/x-moz-place-container' || json.root === 'placesRoot')
  );
}

/** Converts one Firefox node. Returns null for nodes that must be skipped. */
function convertNode(node: unknown, stats: { urls: number }, depth: number): BookmarkNode | null {
  if (!isObject(node) || depth > MAX_DEPTH) return null;
  const title = typeof node.title === 'string' ? node.title : '';
  if (node.type === 'text/x-moz-place-separator') return { type: 'separator', title: '' };
  if (node.type === 'text/x-moz-place') {
    if (typeof node.uri !== 'string' || node.uri === '') return null;
    // place: URIs are Firefox smart queries; bookmarklets (javascript:) are kept.
    if (/^place:/i.test(node.uri.trim())) return null;
    stats.urls++;
    const out: BookmarkNode = { title, url: node.uri };
    if (typeof node.dateAdded === 'number' && Number.isFinite(node.dateAdded)) {
      out.dateAdded = Math.round(node.dateAdded / 1000);
    }
    return out;
  }
  if (node.type === 'text/x-moz-place-container' || Array.isArray(node.children)) {
    if (node.root === 'tagsFolder') return null;
    const children: BookmarkNode[] = [];
    const out: BookmarkNode = { title, children };
    const folderType = typeof node.root === 'string' ? FOLDER_TYPES[node.root] : undefined;
    if (folderType) out.folderType = folderType;
    else if (node.root === 'bookmarksMenuFolder') out.id = 'menu________';
    for (const child of Array.isArray(node.children) ? (node.children as unknown[]) : []) {
      const c = convertNode(child, stats, depth + 1);
      if (c) children.push(c);
    }
    return out;
  }
  return null;
}

/**
 * Converts a parsed Firefox backup to a (not yet normalised) native backup object.
 * @throws {BackupFormatError}
 */
export function convertFirefoxBookmarks(json: unknown): Backup {
  const stats = { urls: 0 };
  const root = convertNode(json, stats, 0);
  if (!root || stats.urls === 0) throw new BackupFormatError('No bookmarks found in the Firefox backup.');
  root.title = '';
  delete root.folderType;
  delete root.id;
  const backup = emptyBackup({ format: 'firefox-bookmarks-json', browser: 'unknown' });
  backup.bookmarks = [root];
  return backup;
}

/** Convenience wrapper that parses text first. */
export function convertFirefoxBookmarksText(text: string): Backup {
  assertSize(text);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BackupFormatError('The file is not valid JSON.');
  }
  return convertFirefoxBookmarks(json);
}
