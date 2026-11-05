import { describe, expect, it } from 'vitest';
import type { Backup, BackupTab, BackupWindow, BookmarkNode } from '../src/lib/schema';
import { diffBackups, isEmptyDiff } from '../src/lib/snapshot-diff';

const tab = (url: string, title = url): BackupTab => ({ url, title, pinned: false });
const backup = (windows: Array<Partial<BackupWindow>>, bookmarks: BookmarkNode[] = []): Backup => ({
  schemaVersion: '1.1',
  exportedAt: null,
  source: {},
  windows: windows.map((w) => ({ ungroupedTabs: [], groups: [], ...w })),
  bookmarks,
});
const urls = (tabs: BackupTab[]) => tabs.map((x) => x.url);

describe('diffBackups', () => {
  it('finds added, removed and kept tabs across windows and groups', () => {
    const older = backup([
      { ungroupedTabs: [tab('https://a.test/'), tab('https://b.test/')] },
      { groups: [{ title: 'G', color: 'blue', collapsed: false, tabs: [tab('https://c.test/')] }] },
    ]);
    const newer = backup([
      { ungroupedTabs: [tab('https://a.test'), tab('https://d.test/')] },
      { groups: [{ title: 'G', color: 'blue', collapsed: false, tabs: [tab('https://c.test/#frag'), tab('https://e.test/')] }] },
    ]);
    const diff = diffBackups(older, newer);
    expect(urls(diff.tabs.added).sort()).toEqual(['https://d.test/', 'https://e.test/']);
    expect(urls(diff.tabs.removed)).toEqual(['https://b.test/']);
    expect(diff.tabs.kept).toBe(2); // trailing slash and fragment are ignored
    expect(diff.groups).toEqual({ added: [], removed: [] });
  });

  it('counts duplicate URLs once', () => {
    const older = backup([{ ungroupedTabs: [tab('https://a.test/')] }]);
    const newer = backup([
      { ungroupedTabs: [tab('https://a.test/'), tab('https://n.test/'), tab('https://n.test/')] },
      { ungroupedTabs: [tab('https://n.test/')] },
    ]);
    const diff = diffBackups(older, newer);
    expect(diff.tabs.added).toHaveLength(1);
    expect(diff.tabs.kept).toBe(1);
    expect(diff.tabs.removed).toHaveLength(0);
  });

  it('diffs groups by title and ignores untitled ones', () => {
    const group = (title: string) => ({ title, color: 'grey' as const, collapsed: false, tabs: [] });
    const older = backup([{ groups: [group('Old'), group(''), group('Both')] }]);
    const newer = backup([{ groups: [group('New'), group('  '), group('Both')] }]);
    expect(diffBackups(older, newer).groups).toEqual({ added: ['New'], removed: ['Old'] });
  });

  it('diffs URL bookmarks inside folders and skips folders themselves', () => {
    const older = backup([], [
      { title: 'bar', children: [{ title: 'A', url: 'https://a.test/' }, { title: 'Gone', url: 'https://gone.test/' }] },
    ]);
    const newer = backup([], [
      { title: 'bar', children: [{ title: 'Folder', children: [{ title: 'A again', url: 'https://a.test' }, { title: 'New', url: 'https://new.test/' }] }] },
    ]);
    const { bookmarks } = diffBackups(older, newer);
    expect(bookmarks.added.map((b) => b.title)).toEqual(['New']);
    expect(bookmarks.removed.map((b) => b.title)).toEqual(['Gone']);
  });

  it('reports an empty diff for identical content', () => {
    const a = backup([{ ungroupedTabs: [tab('https://a.test/')] }], [{ title: 'x', url: 'https://x.test/' }]);
    const diff = diffBackups(a, structuredClone(a));
    expect(isEmptyDiff(diff)).toBe(true);
    expect(diff.tabs.kept).toBe(1);
  });
});
