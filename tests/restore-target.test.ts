// @ts-nocheck -- exercises the untyped in-memory fake browser.
/**
 * Export scope, restore target (current window), merging into existing groups and Firefox containers.
 * Real exporter/importer/adapter against the fake browser.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { _resetBrowserCache, detectBrowserAsync } from '../src/lib/browser-detect';
import { UniversalExporter } from '../src/lib/exporter';
import { UniversalImporter } from '../src/lib/importer';
import { createFakeBrowser } from './helpers/fake-browser';

let fb;
const exportOpts = { includeTabs: true, includeBookmarks: false };

async function setup(family = 'chromium') {
  fb = createFakeBrowser({ family });
  _resetBrowserCache();
  return detectBrowserAsync();
}

const tab = (url, extra = {}) => ({ url, title: url, index: 0, pinned: false, ...extra });
const backup = (windows) => ({
  schemaVersion: '1.1',
  windows,
  bookmarks: [],
});
const urls = (wid) => fb.tabUrls(wid);
const idsOf = (wid) => fb.windows.get(wid).tabIds;

// ---------------------------------------------------------------- export scope

describe('export scope', () => {
  let info, w1, w2, gid;
  beforeEach(async () => {
    info = await setup();
    w1 = fb.seedWindow({ focused: true }, ['https://a.example/', 'https://g1.example/', 'https://g2.example/']);
    w2 = fb.seedWindow({}, ['https://b.example/', 'https://g3.example/']);
    gid = fb.seedGroup([w1.tabs[1].id, w1.tabs[2].id], { title: 'G', color: 'red' });
    fb.seedGroup([w2.tabs[1].id], { title: 'Other', color: 'blue' });
  });
  const run = (scope) => new UniversalExporter({ browser: info }).export({ ...exportOpts, scope });

  it('exports every window without a scope', async () => {
    const { data } = await run(undefined);
    expect(data.windows).toHaveLength(2);
  });

  it('windowId: only that window', async () => {
    const { data, stats } = await run({ windowId: w2.window.id });
    expect(data.windows).toHaveLength(1);
    expect(data.windows[0].ungroupedTabs.map((t) => t.url)).toEqual(['https://b.example/']);
    expect(stats.tabs).toBe(2);
  });

  it('groupId: one window holding only that group', async () => {
    const { data, stats } = await run({ groupId: gid });
    expect(data.windows).toHaveLength(1);
    expect(data.windows[0].ungroupedTabs).toEqual([]);
    expect(data.windows[0].groups).toHaveLength(1);
    expect(data.windows[0].groups[0].title).toBe('G');
    expect(data.windows[0].groups[0].tabs.map((t) => t.url)).toEqual(['https://g1.example/', 'https://g2.example/']);
    expect(stats).toMatchObject({ windows: 1, tabs: 2, groups: 1 });
  });

  it('unknown window or group: empty windows, no error', async () => {
    expect((await run({ windowId: 99999 })).data.windows).toEqual([]);
    expect((await run({ groupId: 99999 })).data.windows).toEqual([]);
  });

  it('scope does not decide bookmarks', async () => {
    fb.seedBookmark(fb.roots.bar, { title: 'x', url: 'https://bm.example/' });
    const out = await new UniversalExporter({ browser: info }).export({
      includeTabs: true, includeBookmarks: true, scope: { windowId: w1.window.id },
    });
    expect(out.stats.bookmarks).toBe(1);
    expect(out.stats.windows).toBe(1);
  });
});

// -------------------------------------------------------------- current window

describe('restore target: current-window', () => {
  let info, current, other;
  beforeEach(async () => {
    info = await setup();
    other = fb.seedWindow({}, ['https://other.example/']);
    current = fb.seedWindow({ focused: true }, [
      { url: 'https://c1.example/', active: true },
      'https://c2.example/',
    ]);
  });
  const data = () => backup([
    {
      focused: true, state: 'maximized', width: 500, height: 400, left: 3, top: 4,
      ungroupedTabs: [tab('https://n1.example/', { index: 0, active: true }), tab('https://n2.example/', { index: 1 })],
      groups: [{ title: 'Work', color: 'green', collapsed: false, tabs: [tab('https://g1.example/', { index: 2 })] }],
    },
    { ungroupedTabs: [tab('https://n3.example/', { index: 0 })], groups: [] },
  ]);
  const run = (opts = {}) =>
    new UniversalImporter({ browser: info }).import(data(), { importTabs: true, importBookmarks: false, ...opts });

  it('appends to the last focused window, creates no window', async () => {
    const res = await run({ target: 'current-window' });
    await fb.settle();
    expect(fb.calls.windowsCreate).toHaveLength(0);
    expect(res.windows).toBe(0);
    expect(res.tabs).toBe(4);
    expect(urls(current.window.id)).toEqual([
      'https://c1.example/', 'https://c2.example/',
      'https://n1.example/', 'https://n2.example/', 'https://g1.example/', 'https://n3.example/',
    ]);
    expect(urls(other.window.id)).toEqual(['https://other.example/']);
    expect(fb.windows.size).toBe(2);
  });

  it('recreates groups in that window and counts them', async () => {
    const res = await run({ target: 'current-window' });
    expect(res.groups).toBe(1);
    const g = [...fb.groups.values()];
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ windowId: current.window.id, title: 'Work', color: 'green' });
  });

  it('ignores window layout and does not change the active tab or focus', async () => {
    await run({ target: 'current-window', focusRestored: true });
    const w = fb.windows.get(current.window.id);
    expect(w).toMatchObject({ state: 'normal', width: 1200, height: 800, focused: true });
    const active = idsOf(current.window.id).filter((id) => fb.tabs.get(id).active);
    expect(active).toEqual([current.tabs[0].id]);
  });

  it('falls back to new windows when there is no normal window', async () => {
    fb.windows.clear(); fb.tabs.clear(); fb.groups.clear();
    fb.seedWindow({ type: 'popup', focused: true }, ['https://pop.example/']);
    const res = await run({ target: 'current-window' });
    await fb.settle();
    expect(fb.calls.windowsCreate.length).toBe(2);
    expect(res.windows).toBe(2);
  });

  it('default target still opens new windows', async () => {
    const res = await run();
    expect(res.windows).toBe(2);
    expect(fb.calls.windowsCreate).toHaveLength(2);
  });

  it('without tab group support, groups are flattened into the same window', async () => {
    info = { ...info, features: { ...info.features, tabGroups: false } };
    const res = await run({ target: 'current-window' });
    expect(res.windows).toBe(0);
    expect(res.groups).toBe(0);
    expect(urls(current.window.id)).toHaveLength(6);
  });
});

// ----------------------------------------------------------------- mergeGroups

describe('mergeGroups', () => {
  let info, win;
  beforeEach(async () => {
    info = await setup();
    win = fb.seedWindow({ focused: true }, ['https://e1.example/', 'https://e2.example/', 'https://e3.example/']);
  });
  const data = (title) => backup([{
    ungroupedTabs: [],
    groups: [{ title, color: 'red', collapsed: true, tabs: [tab('https://n1.example/'), tab('https://n2.example/', { index: 1 })] }],
  }]);
  const run = (title, opts) =>
    new UniversalImporter({ browser: info }).import(data(title), {
      importTabs: true, importBookmarks: false, target: 'current-window', ...opts,
    });

  it('adds to an existing same-titled group without restyling it', async () => {
    const gid = fb.seedGroup([win.tabs[0].id], { title: 'Work', color: 'blue', collapsed: false });
    const res = await run('Work', { mergeGroups: true });
    expect(fb.groups.size).toBe(1);
    expect(fb.groups.get(gid)).toMatchObject({ title: 'Work', color: 'blue', collapsed: false });
    const members = [...fb.tabs.values()].filter((t) => t.groupId === gid).map((t) => t.url || t.pendingUrl);
    expect(members).toHaveLength(3);
    expect(res.groups).toBe(1);
    expect(fb.calls.tabsGroup.at(-1)).toMatchObject({ groupId: gid });
    expect(fb.calls.tabsGroup.at(-1).createProperties).toBeUndefined();
  });

  it('does not merge when mergeGroups is off', async () => {
    fb.seedGroup([win.tabs[0].id], { title: 'Work' });
    await run('Work', {});
    expect(fb.groups.size).toBe(2);
  });

  it('does not merge into untitled groups or different titles', async () => {
    fb.seedGroup([win.tabs[0].id], { title: '' });
    fb.seedGroup([win.tabs[1].id], { title: 'work' });
    await run('', { mergeGroups: true });
    await run('Work', { mergeGroups: true });
    expect(fb.groups.size).toBe(4);
  });

  it('creates the group when none matches', async () => {
    const res = await run('Fresh', { mergeGroups: true });
    expect(res.groups).toBe(1);
    expect([...fb.groups.values()].map((g) => g.title)).toEqual(['Fresh']);
  });
});

// ------------------------------------------------------------------ containers

describe('containers: export', () => {
  it('writes container info on Firefox and skips the default store', async () => {
    const info = await setup('gecko');
    const c = fb.seedContainer({ name: 'Shopping', color: 'pink', icon: 'cart' });
    fb.seedWindow({ focused: true }, [
      { url: 'https://shop.example/', cookieStoreId: c.cookieStoreId },
      'https://plain.example/',
    ]);
    const { data } = await new UniversalExporter({ browser: info }).export(exportOpts);
    const tabs = data.windows[0].ungroupedTabs;
    expect(tabs[0].container).toEqual({ name: 'Shopping', color: 'pink', icon: 'cart' });
    expect(tabs[1].container).toBeUndefined();
  });

  it('skips private stores and survives lookup failures', async () => {
    const info = await setup('gecko');
    fb.seedWindow({ focused: true }, [
      { url: 'https://p.example/', cookieStoreId: 'firefox-private' },
    ]);
    const { data } = await new UniversalExporter({ browser: info }).export(exportOpts);
    expect(data.windows[0].ungroupedTabs[0].container).toBeUndefined();
    fb.seedWindow({}, []);
    const t = fb.seedTab([...fb.windows.keys()][0], 'https://x.example/');
    t.cookieStoreId = 'firefox-container-404'; // unknown identity: lookup rejects
    const again = await new UniversalExporter({ browser: info }).export(exportOpts);
    expect(again.stats.tabs).toBe(2);
  });

  it('does not write containers on Chromium', async () => {
    const info = await setup('chromium');
    fb.seedWindow({ focused: true }, [{ url: 'https://shop.example/', cookieStoreId: 'firefox-container-1' }]);
    const { data } = await new UniversalExporter({ browser: info }).export(exportOpts);
    expect(data.windows[0].ungroupedTabs[0].container).toBeUndefined();
  });
});

describe('containers: restore', () => {
  const data = (container) => backup([{
    focused: true,
    ungroupedTabs: [
      tab('https://shop.example/', { index: 0, active: true, container }),
      tab('https://later.example/', { index: 1, container }),
      tab('https://plain.example/', { index: 2 }),
    ],
    groups: [],
  }]);
  const run = (info, container, opts = {}, failures = []) =>
    new UniversalImporter({ browser: info }).import(data(container), {
      importTabs: true, importBookmarks: false, ...opts,
    }).then((r) => { failures.push(...r.failures); return r; });
  const storeOf = (url) => [...fb.tabs.values()].find((t) => (t.url || t.pendingUrl) === url)?.cookieStoreId;

  it('uses an existing container (matched by name), also for discarded tabs', async () => {
    const info = await setup('gecko');
    const c = fb.seedContainer({ name: 'Shopping' });
    const res = await run(info, { name: 'Shopping', color: 'pink', icon: 'cart' });
    expect(storeOf('https://shop.example/')).toBe(c.cookieStoreId);
    expect(storeOf('https://later.example/')).toBe(c.cookieStoreId);
    expect(storeOf('https://plain.example/')).toBe('firefox-default');
    expect(fb.calls.identitiesCreate).toHaveLength(0);
    expect(fb.calls.tabsCreate.find((o) => o.url === 'https://later.example/').discarded).toBe(true);
    expect(res.tabs).toBe(3);
  });

  it('creates a missing container once, with the backup color/icon', async () => {
    const info = await setup('gecko');
    await run(info, { name: 'Banking', color: 'green', icon: 'dollar' });
    expect(fb.calls.identitiesCreate).toEqual([{ name: 'Banking', color: 'green', icon: 'dollar' }]);
    expect(storeOf('https://shop.example/')).toBe(storeOf('https://later.example/'));
    expect(storeOf('https://shop.example/')).not.toBe('firefox-default');
  });

  it('falls back to safe defaults for unknown color/icon', async () => {
    const info = await setup('gecko');
    await run(info, { name: 'Odd', color: 'mauve', icon: 'rocket' });
    expect(fb.calls.identitiesCreate).toEqual([{ name: 'Odd', color: 'blue', icon: 'fingerprint' }]);
  });

  it('on failure opens the tab without a container and reports it', async () => {
    const info = await setup('gecko');
    fb.chrome.contextualIdentities.query = async () => { throw new Error('denied'); };
    const failures = [];
    const res = await run(info, { name: 'Shopping' }, {}, failures);
    expect(res.tabs).toBe(3);
    expect(res.tabsFailed).toBe(0);
    expect(storeOf('https://shop.example/')).toBe('firefox-default');
    const reasons = failures.filter((f) => f.reason === 'container-unavailable');
    expect(reasons.map((f) => f.url)).toEqual(['https://shop.example/', 'https://later.example/']);
    expect(reasons[0]).toMatchObject({ kind: 'tab', title: 'https://shop.example/' });
  });

  it('retries without the container when tabs.create rejects the cookieStoreId', async () => {
    const info = await setup('gecko');
    const c = fb.seedContainer({ name: 'Shopping' });
    fb.identities.delete(c.cookieStoreId); // query still finds nothing -> would create; make create return a stale id
    fb.chrome.contextualIdentities.create = async () => ({ cookieStoreId: 'firefox-container-stale', name: 'Shopping' });
    const failures = [];
    const res = await run(info, { name: 'Shopping' }, {}, failures);
    expect(res.tabs).toBe(3);
    expect(storeOf('https://shop.example/')).toBe('firefox-default');
    expect(failures.some((f) => f.reason === 'container-unavailable')).toBe(true);
  });

  it('restoreContainers:false ignores containers', async () => {
    const info = await setup('gecko');
    fb.seedContainer({ name: 'Shopping' });
    await run(info, { name: 'Shopping' }, { restoreContainers: false });
    expect(storeOf('https://shop.example/')).toBe('firefox-default');
    expect(fb.calls.tabsCreate.every((o) => !('cookieStoreId' in o))).toBe(true);
  });

  it('Chromium ignores containers silently', async () => {
    const info = await setup('chromium');
    const failures = [];
    const res = await run(info, { name: 'Shopping' }, {}, failures);
    expect(res.tabs).toBe(3);
    expect(failures).toEqual([]);
    expect(fb.calls.tabsCreate.every((o) => !('cookieStoreId' in o))).toBe(true);
  });
});
