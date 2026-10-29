import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { UniversalExporter } from '../src/lib/exporter';
import type { BrowserInfo } from '../src/lib/browser-detect';
import type { BackupWindow } from '../src/lib/schema';
import { createFakeBrowser } from './helpers/fake-browser';

const big = 'data:image/png;base64,' + 'A'.repeat(5000);
const susp = 'chrome-extension://abc/suspended.html#ttl=x&pos=0&uri=https://example.com/a?b=1';
const tabs = () => [
  { url: 'https://github.com/a', title: 'A', index: 0, pinned: true, groupId: 5, favIconUrl: 'https://x/i.png' },
  { url: 'chrome://settings', title: 'S', index: 1, groupId: -1 },
  { url: '', pendingUrl: 'https://gist.github.com/z', title: 'L', index: 2, groupId: 5, active: true, favIconUrl: big },
  { url: 'https://notgithub.com/', title: 'N', index: 3, groupId: -1 },
  { url: susp, title: 'Susp', index: 4, groupId: -1 },
  { url: 'https://github.com/b', title: 'B', index: 5, groupId: -1, workspaceName: 'WS', workspaceId: 'w1' },
  { index: 6 },
];
const bookmarkTree = () => [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        parentId: '0',
        title: 'Bar',
        folderType: 'bookmarks-bar',
        children: [
          { id: '10', title: 'gh', url: 'https://gist.github.com/x', dateAdded: 1, syncing: true },
          { id: '11', title: 'no', url: 'https://notgithub.com/' },
          { id: '12', title: 'int', url: 'chrome://flags' },
          { id: '13', title: 'F', children: [{ id: '14', title: 'x', url: 'https://other.org' }] },
          { id: '15', title: 'F2', children: [{ id: '16', title: 'y', url: 'https://github.com/y' }] },
        ],
      },
      { id: '2', parentId: '0', title: 'Other', folderType: 'other', children: [] },
    ],
  },
];

/** The exporter reads raw browser.* responses, so override them with a fixed fixture. */
function stubApis() {
  const rt = browser.runtime as unknown as { getManifest: () => unknown };
  const win = browser.windows as unknown as { getAll: unknown };
  const grp = (browser as unknown as { tabGroups: { query: unknown } }).tabGroups;
  const bm = browser.bookmarks as unknown as { getTree: unknown };
  rt.getManifest = () => ({ version: '9.9.9' });
  win.getAll = async () => [
    { id: 1, type: 'normal', focused: true, state: 'maximized', left: 1, top: 2, width: 3, height: 4, tabs: tabs() },
    { id: 2, type: 'normal', incognito: true, tabs: [{ url: 'https://github.com/inc', index: 0, groupId: -1 }] },
    { id: 3, type: 'popup', tabs: [{ url: 'https://github.com/p', groupId: -1 }] },
  ];
  grp.query = async () => [{ id: 5, title: 'G', color: 'weird', collapsed: true }];
  bm.getTree = async () => bookmarkTree();
}

const info: BrowserInfo = {
  key: 'chrome',
  name: 'Chrome',
  family: 'chromium',
  features: {
    tabGroups: true, groupColors: true, groupCollapse: true, bookmarks: true, downloads: true,
    discard: true, discardOnCreate: false, alarms: true, sessionStorage: true,
  },
};
const withFeatures = (f: Partial<BrowserInfo['features']>): BrowserInfo => ({
  ...info,
  features: { ...info.features, ...f },
});
const flatTabs = (w: BackupWindow) => [...w.ungroupedTabs, ...w.groups.flatMap((g) => g.tabs)];
const win0 = (windows: BackupWindow[]): BackupWindow => {
  const w = windows[0];
  if (!w) throw new Error('expected a window');
  return w;
};
const group = (w: BackupWindow, i: number) => {
  const g = w.groups[i];
  if (!g) throw new Error(`expected group ${i}`);
  return g;
};
const byTitle = (w: BackupWindow, title: string) => {
  const t = flatTabs(w).find((x) => x.title === title);
  if (!t) throw new Error(`expected tab ${title}`);
  return t;
};
const must = <T>(v: T | null | undefined): T => {
  if (v == null) throw new Error('expected a value');
  return v;
};
const sortedIdx = (w: BackupWindow) => flatTabs(w).map((t) => t.index).sort();

describe('UniversalExporter', () => {
  beforeEach(() => {
    createFakeBrowser();
    stubApis();
  });
  const ex = () => new UniversalExporter({ browser: info });

  it('exports without filters', async () => {
    const { data, stats } = await ex().export({ includeTabs: true, includeBookmarks: true });
    expect(data.schemaVersion).toBe('1.1');
    expect(data.source.extensionVersion).toBe('9.9.9');
    expect(data.source.groupSystem).toBe('tabGroups');
    expect(data.windows).toHaveLength(1); // incognito and popup windows excluded
    const w = win0(data.windows);
    expect(w.state).toBe('maximized');
    expect(w.width).toBe(3);
    expect(stats.tabs).toBe(6);
    expect(stats.skippedTabs).toBe(1); // tab without a URL skipped
    expect(sortedIdx(w)).toEqual([0, 1, 2, 3, 4, 5]);
    // pinned tabs are never grouped
    expect(w.ungroupedTabs.find((t) => t.url === 'https://github.com/a' && t.pinned)).toBeTruthy();
    expect(w.groups).toHaveLength(2);
    expect(group(w, 0).title).toBe('G');
    expect(group(w, 0).color).toBe('grey'); // unknown color normalised
    expect(group(w, 0).tabs).toHaveLength(1);
    expect(group(w, 1).metadata?.type).toBe('workspace');
    const loading = group(w, 0).tabs[0];
    expect(loading?.url).toBe('https://gist.github.com/z'); // pendingUrl used for loading tabs
    expect(loading?.active).toBe(true);
    expect(loading?.favIconUrl).toBeUndefined(); // favicons off by default
    const sp = byTitle(w, 'Susp');
    expect(sp.url).toBe('https://example.com/a?b=1');
    expect(sp.metadata?.originalUrl).toBe(susp);
    expect(byTitle(w, 'A').metadata).toBeUndefined();
    expect(stats.bookmarks).toBe(5);
  });

  it('includes favicons only when asked and drops oversized data: icons', async () => {
    const { data } = await ex().export({ includeTabs: true, includeBookmarks: false, includeFavicons: true });
    const w = win0(data.windows);
    expect(byTitle(w, 'A').favIconUrl).toBe('https://x/i.png');
    expect(byTitle(w, 'L').favIconUrl).toBeUndefined();
  });

  it('can include incognito, keep placeholders and omit layout', async () => {
    const { data } = await ex().export({
      includeTabs: true,
      includeBookmarks: false,
      includeIncognito: true,
      unwrapPlaceholders: false,
      includeWindowLayout: false,
    });
    expect(data.windows).toHaveLength(2);
    const w = win0(data.windows);
    expect(w.state).toBeUndefined();
    expect(w.ungroupedTabs.find((t) => t.title === 'Susp')?.url).toBe(susp);
  });

  it('applies domain and internal-page filters to tabs and bookmarks', async () => {
    const { data, stats } = await ex().export({
      includeTabs: true,
      includeBookmarks: true,
      filters: { domains: ['https://GitHub.com/x'], excludeInternal: true, applyToBookmarks: true },
    });
    const w = win0(data.windows);
    const urls = flatTabs(w).map((t) => t.url).sort();
    // notgithub.com must not match github.com
    expect(urls).toEqual(['https://github.com/a', 'https://github.com/b', 'https://gist.github.com/z'].sort());
    expect(sortedIdx(w)).toEqual([0, 1, 2]); // indices compacted
    expect(data.source.filtersApplied).toEqual({ excludeInternal: true, domains: ['github.com'], applyToBookmarks: true });
    const root = data.bookmarks[0];
    expect(root?.children).toHaveLength(2); // empty system folders are kept
    const bar = root?.children?.[0];
    expect(bar?.children?.map((c) => c.id)).toEqual(['10', '15']);
    expect((bar?.children?.[0] as unknown as Record<string, unknown>).syncing).toBeUndefined();
    expect(stats.bookmarks).toBe(2);
  });

  it('excludeInternal alone leaves bookmarks untouched', async () => {
    const { stats } = await ex().export({
      includeTabs: false,
      includeBookmarks: true,
      filters: { excludeInternal: true },
    });
    expect(stats.bookmarks).toBe(5);
  });

  it('exports empty bookmarks and no groups when unsupported', async () => {
    const ex2 = new UniversalExporter({ browser: withFeatures({ tabGroups: false, bookmarks: false }) });
    const { data } = await ex2.export({ includeTabs: true, includeBookmarks: true });
    expect(data.bookmarks).toEqual([]);
    expect(data.source.groupSystem).toBe('none');
    expect(win0(data.windows).groups).toHaveLength(1); // only the workspace group
  });

  it('propagates windows API errors', async () => {
    vi.spyOn(browser.windows, 'getAll').mockRejectedValue(new Error('boom'));
    await expect(ex().export({ includeTabs: true, includeBookmarks: false })).rejects.toThrow(/boom/);
    vi.restoreAllMocks();
  });
});

describe('UniversalExporter against the fake browser', () => {
  it('round-trips seeded windows, groups and bookmarks', async () => {
    // The helper is untyped (ts-nocheck); view it through a minimal interface.
    const fb = createFakeBrowser() as unknown as {
      seedWindow: (o: object, t: string[]) => { window: { id: number }; tabs: Array<{ id: number }> };
      seedGroup: (ids: number[], o: object) => number;
      seedBookmark: (parent: string, spec: object) => unknown;
      roots: Record<string, string>;
    };
    const { window: w, tabs: ts } = fb.seedWindow({ focused: true }, [
      'https://a.com/',
      'https://b.com/',
      'https://c.com/',
    ]);
    fb.seedGroup([must(ts[1]).id, must(ts[2]).id], { title: 'Work', color: 'blue' });
    fb.seedBookmark(must(fb.roots.bar), { title: 'Bar link', url: 'https://bar.example/' });
    const real = new UniversalExporter({ browser: info });
    const { data, stats } = await real.export({ includeTabs: true, includeBookmarks: true });
    expect(stats.tabs).toBe(3);
    const win = win0(data.windows);
    expect(group(win, 0).title).toBe('Work');
    expect(group(win, 0).tabs).toHaveLength(2);
    expect(stats.bookmarks).toBe(1);
    expect(w.id).toBeTruthy();
  });
});
