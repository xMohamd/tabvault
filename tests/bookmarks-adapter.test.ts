// @ts-nocheck -- the minimal bookmarks API mock below is deliberately loose.
import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { BookmarksAdapter, rootRole } from '../src/lib/adapters/bookmarks-adapter';
import { createFakeBrowser } from './helpers/fake-browser';

beforeEach(() => {
  createFakeBrowser(); // silences console; bookmarks API is replaced per test below
});

/** Minimal bookmarks API over a custom set of root folders (e.g. a localized Chrome). */
function makeChrome(roots, { failUrl } = {}) {
  let n = 100;
  const nodes = new Map();
  const add = (parentId, spec) => {
    const node = { id: spec.id ?? String(n++), parentId, title: spec.title ?? '', ...spec.extra };
    if (spec.url) node.url = spec.url; else node.children = [];
    nodes.set(node.id, node);
    if (parentId) nodes.get(parentId).children.push(node);
    return node;
  };
  const root = add(null, { id: '0' });
  for (const r of roots) add('0', r);
  const clone = (x) => structuredClone(x);
  fakeBrowser.bookmarks = {
    getTree: async () => [clone(root)],
    getChildren: async (id) => clone(nodes.get(id).children),
    create: async ({ parentId, title, url, type }) => {
      if (failUrl && url === failUrl) throw new Error('boom');
      if (!nodes.has(parentId)) throw new Error('bad parent');
      const spec = type === 'separator' ? { title: '', extra: { type: 'separator' } } : { title, url };
      return clone(add(parentId, spec));
    },
    remove: async (id) => { const x = nodes.get(id); nodes.get(x.parentId).children = nodes.get(x.parentId).children.filter((c) => c !== x); },
    removeTree: async (id) => fakeBrowser.bookmarks.remove(id),
  };
  return { root, nodes };
}
const chromeRoots = () => [
  { id: '1', title: 'Bookmarks bar', extra: { folderType: 'bookmarks-bar' } },
  { id: '2', title: 'Otros marcadores', extra: { folderType: 'other' } },
  { id: '3', title: 'Mobile bookmarks', extra: { folderType: 'mobile' } },
];
const b = (title, url) => ({ title, url });
const f = (title, children, extra = {}) => ({ title, children, ...extra });
const chromeExport = () => [{ id: '0', title: '', children: [
  f('Bookmarks bar', [b('A', 'https://a.com/'), f('Dev', [b('B', 'https://b.com')])], { id: '1', parentId: '0', folderType: 'bookmarks-bar' }),
  f('Other bookmarks', [b('C', 'https://c.com')], { id: '2', parentId: '0', folderType: 'other' }),
  f('Mobile bookmarks', [b('M', 'https://m.com')], { id: '3', parentId: '0', folderType: 'mobile' }),
  f('Managed', [b('Corp', 'https://corp.com')], { id: '4', parentId: '0', folderType: 'managed', unmodifiable: 'managed' }),
] }];
const ffExport = () => [{ id: 'root________', title: '', children: [
  f('Bookmarks Menu', [b('Menu1', 'https://menu.com')], { id: 'menu________', parentId: 'root________' }),
  f('Bookmarks Toolbar', [b('T1', 'https://t.com'), { type: 'separator', title: '' }, b('JS', 'javascript:alert(1)'), b('Moz', 'moz-extension://x/y')], { id: 'toolbar_____', parentId: 'root________' }),
  f('Other Bookmarks', [b('U1', 'https://u.com')], { id: 'unfiled_____', parentId: 'root________' }),
  f('Mobile Bookmarks', [b('M1', 'https://m1.com')], { id: 'mobile______', parentId: 'root________' }),
] }];

const kids = (nodes, id) => nodes.get(id).children;
const titles = (nodes, id) => kids(nodes, id).map((c) => c.title);

describe('rootRole', () => {
  it('resolves roles by folderType, id, managed flag and (opt-in) title', () => {
    expect(rootRole({ folderType: 'bookmarks-bar' })).toBe('bar');
    expect(rootRole({ id: 'menu________' })).toBe('menu');
    expect(rootRole({ id: '2' })).toBe('other');
    expect(rootRole({ unmodifiable: 'managed' })).toBe('managed');
    expect(rootRole({ title: 'Bookmarks Bar' })).toBeNull();
    expect(rootRole({ title: ' Bookmarks Bar ' }, { allowTitle: true })).toBe('bar');
    expect(rootRole({ id: 'constructor', title: 'x' })).toBeNull();
    expect(rootRole(null)).toBeNull();
  });
});

describe('BookmarksAdapter: Chrome export into Chrome', () => {
  it('merge maps roots by folderType, skips managed, is idempotent', async () => {
    const { root, nodes } = makeChrome(chromeRoots());
    const ad = new BookmarksAdapter({ family: 'chromium' });
    const prog = [];
    const r1 = await ad.import(chromeExport(), { strategy: 'merge', onProgress: (c, t) => prog.push([c, t]) });
    expect(root.children.length, 'no junk root folder').toBe(3);
    expect(titles(nodes, '1')).toEqual(['A', 'Dev']);
    expect(titles(nodes, '2')).toEqual(['C']);
    expect(titles(nodes, '3')).toEqual(['M']);
    expect([r1.created, r1.skipped, r1.failed]).toEqual([4, 1, 0]);
    expect(prog.at(-1)).toEqual([5, 5]);
    expect([...nodes.values()].some((n) => n.title === 'Corp'), 'managed folder never written').toBe(false);

    const r2 = await ad.import(chromeExport(), { strategy: 'merge' });
    expect([r2.created, r2.skipped]).toEqual([0, 5]);
    expect(titles(nodes, '1'), 'no duplicate folders').toEqual(['A', 'Dev']);
    expect(kids(nodes, '1')[1].children.length).toBe(1);
  });

  it('folder strategy wraps everything in one new folder', async () => {
    const { nodes } = makeChrome(chromeRoots());
    const r = await new BookmarksAdapter({ family: 'chromium' }).import(chromeExport(), { strategy: 'folder' });
    expect(r.folderId).toBeTruthy();
    expect(r.created).toBe(4);
    expect(titles(nodes, r.folderId)).toEqual(['Bookmarks bar', 'Other bookmarks', 'Mobile bookmarks']);
  });

  it('replace clears the system folders first', async () => {
    const { nodes } = makeChrome(chromeRoots());
    const ad = new BookmarksAdapter({ family: 'chromium' });
    await ad.import([{ id: '0', children: [f('Bookmarks bar', [b('Old', 'https://old.com')], { id: '1', folderType: 'bookmarks-bar' })] }], { strategy: 'merge' });
    expect(titles(nodes, '1')).toEqual(['Old']);
    const r = await ad.import(chromeExport(), { strategy: 'replace' });
    expect(titles(nodes, '1')).toEqual(['A', 'Dev']);
    expect(titles(nodes, '2')).toEqual(['C']);
    expect(r.created).toBe(4);
  });

  it('reports a failing bookmark and keeps going', async () => {
    const { nodes } = makeChrome(chromeRoots(), { failUrl: 'https://a.com/' });
    const fails = [];
    const r = await new BookmarksAdapter({ family: 'chromium' }).import(chromeExport(), { strategy: 'merge', onFailure: (x) => fails.push(x) });
    expect(r.failed).toBe(1);
    expect(fails.length).toBe(1);
    expect(fails[0].kind).toBe('bookmark');
    expect(titles(nodes, '1')).toEqual(['Dev']);
  });
});

describe('BookmarksAdapter: Firefox export into Chrome', () => {
  it('maps toolbar/menu/unfiled/mobile, drops separators, reports unsupported URLs', async () => {
    const { root, nodes } = makeChrome(chromeRoots());
    const ad = new BookmarksAdapter({ family: 'chromium' });
    const fails = [];
    const r = await ad.import(ffExport(), { strategy: 'merge', onFailure: (x) => fails.push(x) });
    expect(root.children.length).toBe(3);
    expect(titles(nodes, '1'), 'javascript: bookmarks are allowed by Chrome').toEqual(['T1', 'JS']);
    expect(titles(nodes, '2'), 'menu becomes a subfolder of other').toContain('Bookmarks Menu');
    expect(titles(nodes, '2')).toContain('U1');
    expect(titles(nodes, '3')).toEqual(['M1']);
    expect(fails.length).toBe(1);
    expect(fails[0].reason).toBe('unsupported-url'); // moz-extension
    expect(r.failed).toBe(1);
    expect([...nodes.values()].some((n) => n.type === 'separator')).toBe(false);

    const again = await ad.import(ffExport(), { strategy: 'merge' });
    expect(again.created).toBe(0);
    expect(again.failed).toBe(1);
    expect(titles(nodes, '2').filter((t) => t === 'Bookmarks Menu').length, 'no duplicate menu folder').toBe(1);
  });
});

describe('BookmarksAdapter: Firefox export into Firefox', () => {
  const ffRoots = () => [
    { id: 'menu________', title: 'Bookmarks Menu' }, { id: 'toolbar_____', title: 'Bookmarks Toolbar' },
    { id: 'unfiled_____', title: 'Other Bookmarks' }, { id: 'mobile______', title: 'Mobile Bookmarks' }];

  it('merges by guid, keeps separators once and attempts bookmarklets', async () => {
    const { root, nodes } = makeChrome(ffRoots());
    const ad = new BookmarksAdapter({ family: 'gecko' });
    const fails = [];
    await ad.import(ffExport(), { strategy: 'merge', onFailure: (x) => fails.push(x) });
    expect(root.children.length).toBe(4);
    expect(titles(nodes, 'menu________')).toEqual(['Menu1']);
    expect(kids(nodes, 'toolbar_____').filter((c) => c.type === 'separator').length).toBe(1);
    expect(kids(nodes, 'toolbar_____').filter((c) => c.title === 'T1').length).toBe(1);
    expect(titles(nodes, 'toolbar_____'), 'bookmarklet attempted on Firefox').toContain('JS');
    expect(fails, 'no scheme is pre-rejected here').toEqual([]);

    const r2 = await ad.import(ffExport(), { strategy: 'merge' });
    expect(r2.created).toBe(0);
    expect(kids(nodes, 'toolbar_____').filter((c) => c.type === 'separator').length, 'no stacked separators').toBe(1);
  });

  it('skips bookmarklets when includeBookmarklets is false (counted as skipped)', async () => {
    const { nodes } = makeChrome(ffRoots());
    const fails = [];
    const r = await new BookmarksAdapter({ family: 'gecko' }).import(ffExport(), {
      strategy: 'merge',
      includeBookmarklets: false,
      onFailure: (x) => fails.push(x),
    });
    expect(titles(nodes, 'toolbar_____')).not.toContain('JS');
    expect(fails.some((x) => String(x.url).startsWith('javascript:'))).toBe(false);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
  });

  it('honours cancellation', async () => {
    makeChrome(ffRoots());
    const r = await new BookmarksAdapter({ family: 'gecko' }).import(ffExport(), { strategy: 'merge', isCancelled: () => true });
    expect(r.cancelled).toBe(true);
    expect(r.created).toBe(0);
  });
});
