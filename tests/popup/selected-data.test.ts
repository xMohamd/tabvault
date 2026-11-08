// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { emptyBackup, type Backup, type BookmarkNode } from '@/lib/schema';
import { dedupKey } from '@/lib/url-utils';
import { defaultSelection, pruneBookmarks, selectedData, selectedTabCount } from '../../src/entrypoints/popup/components/PreviewTree';

const tree = (): BookmarkNode[] => [
  {
    title: 'Bookmarks bar',
    folderType: 'bookmarks-bar',
    children: [
      { title: 'Top', url: 'https://a.example/' },
      { title: 'Dev', children: [{ title: 'Docs', url: 'https://b.example/docs' }, { title: 'Deep', children: [{ title: 'Spec', url: 'https://c.example/spec' }] }] },
      { title: 'Empty after pruning', children: [{ title: 'Nope', url: 'https://d.example/' }] },
    ],
  },
  { title: 'Other bookmarks', folderType: 'other', children: [{ title: 'Misc', url: 'https://e.example/' }] },
  { title: 'Loose folder', children: [{ title: 'Also nope', url: 'https://f.example/' }] },
];
const keys = (...urls: string[]) => new Set(urls.map(dedupKey));
const titles = (nodes: BookmarkNode[]): unknown[] => nodes.map((n) => (n.url ? n.title : [n.title, titles(n.children ?? [])]));

describe('pruneBookmarks', () => {
  it('keeps the ticked bookmarks with the folders leading to them, and nothing else', () => {
    const out = pruneBookmarks(tree(), keys('https://c.example/spec', 'https://a.example/'));
    expect(titles(out)).toEqual([['Bookmarks bar', ['Top', ['Dev', [['Deep', ['Spec']]]]]], ['Other bookmarks', []]]);
  });

  it('drops empty folders but keeps top-level role folders, even when empty', () => {
    const out = pruneBookmarks(tree(), keys('https://e.example/'));
    expect(titles(out)).toEqual([['Bookmarks bar', []], ['Other bookmarks', ['Misc']]]);
    expect(out.every((n) => n.folderType)).toBe(true);
  });

  it('matches addresses by dedupKey (a trailing slash or fragment does not matter)', () => {
    const out = pruneBookmarks(tree(), keys('https://b.example/docs#intro'));
    expect(titles(out)[0]).toEqual(['Bookmarks bar', [['Dev', ['Docs']]]]);
  });

  it('returns nothing for an empty set, apart from the role folders, and does not touch the input', () => {
    const input = tree();
    const before = JSON.stringify(input);
    expect(titles(pruneBookmarks(input, new Set()))).toEqual([['Bookmarks bar', []], ['Other bookmarks', []]]);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('selectedData with ticked results', () => {
  const data = (): Backup => {
    const b = emptyBackup();
    b.windows.push({
      ungroupedTabs: [{ title: 'A', url: 'https://a.example/', pinned: false }],
      groups: [{ title: 'G', color: 'red', collapsed: false, tabs: [{ title: 'B', url: 'https://b.example/', pinned: false }] }],
    });
    b.bookmarks = tree();
    return b;
  };

  it('leaves the bookmarks alone unless a bookmark filter is given', () => {
    const b = data();
    expect(selectedData(b, defaultSelection(b)).bookmarks).toEqual(tree());
  });

  it('prunes tabs and bookmarks independently', () => {
    const b = data();
    const out = selectedData(b, defaultSelection(b), keys('https://b.example/'), keys('https://b.example/docs'));
    expect(out.windows).toHaveLength(1);
    expect(out.windows[0]?.ungroupedTabs).toEqual([]);
    expect(out.windows[0]?.groups.map((g) => g.tabs.map((x) => x.url))).toEqual([['https://b.example/']]);
    expect(titles(out.bookmarks)[0]).toEqual(['Bookmarks bar', [['Dev', ['Docs']]]]);
    expect(selectedTabCount(b, defaultSelection(b), keys('https://b.example/'))).toBe(1);
  });

  it('drops groups and windows left without a ticked tab', () => {
    const b = data();
    const out = selectedData(b, defaultSelection(b), keys('https://a.example/'), new Set());
    expect(out.windows[0]?.groups).toEqual([]);
    expect(selectedData(b, defaultSelection(b), new Set()).windows).toEqual([]);
  });
});
