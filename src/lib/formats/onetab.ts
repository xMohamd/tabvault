/**
 * OneTab export converter. Format: one `URL | Title` per line, blank line between groups.
 */

import { emptyBackup, GROUP_COLORS, BackupFormatError, type Backup, type BackupTab, type BackupWindow } from '../schema';
import { TabBudget, makeTab, markTruncated, assertSize } from './common';

const LINE_RE = /^\S+:\/\/\S+ \| /;

/** Whether the text contains at least one OneTab-style line. */
export function looksLikeOneTab(text: string): boolean {
  return text.split(/\r?\n/).some((line) => LINE_RE.test(line.trim()));
}

/**
 * Converts OneTab export text to a (not yet normalised) native backup object.
 * @throws {BackupFormatError}
 */
export function convertOneTab(text: string): Backup {
  assertSize(text);
  const budget = new TabBudget();
  const blocks: BackupTab[][] = [];
  let current: BackupTab[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      if (current.length) blocks.push(current);
      current = [];
      continue;
    }
    const sep = line.indexOf(' | ');
    const url = sep === -1 ? line : line.slice(0, sep);
    const title = sep === -1 ? '' : line.slice(sep + 3);
    const tab = makeTab(url, title, budget);
    if (tab) current.push(tab);
  }
  if (current.length) blocks.push(current);
  const first = blocks[0];
  if (!first) throw new BackupFormatError('No tabs found in the OneTab export.');

  const win: BackupWindow = { ungroupedTabs: [], groups: [] };
  if (blocks.length === 1) {
    win.ungroupedTabs = first;
  } else {
    blocks.forEach((tabs, i) => {
      win.groups.push({
        title: `OneTab group ${i + 1}`,
        color: GROUP_COLORS[i % GROUP_COLORS.length] ?? 'grey',
        collapsed: false,
        tabs,
      });
    });
  }
  const backup = emptyBackup({ format: 'onetab', browser: 'unknown' });
  backup.windows.push(win);
  markTruncated(backup, budget);
  return backup;
}
