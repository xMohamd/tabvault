// @ts-nocheck -- the call-recording chrome mock below is deliberately loose.
import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { LAZY_PAGE_PATH, TabAdapter } from '../src/lib/adapters/tab-adapter';
import type { BrowserInfo } from '../src/lib/browser-detect';
import { createFakeBrowser } from './helpers/fake-browser';

let calls, nextId, listeners, openTabs, failGroupFor;

/** Call-recording mock: lets us assert exactly which API calls the adapter makes. */
function installChrome(discardOnCreate) {
  calls = { create: [], group: [], groupUpdate: [], remove: [], discard: [], wcreate: [], wremove: [], update: [] };
  nextId = 100;
  listeners = new Set();
  openTabs = [{ id: 1, url: 'https://open.example/' }];
  failGroupFor = null;
  const api = {
    runtime: { getURL: (p) => `chrome-extension://abc${p}` },
    windows: {
      create: async (props) => { calls.wcreate.push(props); const id = nextId++; return { id, tabs: [{ id: nextId++ }] }; },
      remove: async (id) => { calls.wremove.push(id); },
      update: async () => {},
    },
    tabs: {
      query: async () => openTabs,
      get: async (id) => ({ id, url: '' }),
      create: async (props) => {
        calls.create.push(props);
        const id = nextId++;
        if (!discardOnCreate) setTimeout(() => listeners.forEach((l) => l(id, { url: props.url }, { id, url: props.url })), 5);
        return { id, url: discardOnCreate ? props.url : '' };
      },
      update: async (id, p) => { calls.update.push([id, p]); },
      remove: async (id) => { calls.remove.push(id); },
      discard: async (id) => { calls.discard.push(id); return { id }; },
      group: async (p) => {
        if (failGroupFor && p.tabIds.includes(failGroupFor)) throw new Error('boom');
        calls.group.push(p);
        return 900 + calls.group.length;
      },
      onUpdated: { addListener: (l) => listeners.add(l), removeListener: (l) => listeners.delete(l) },
    },
    tabGroups: { update: async (id, p) => { calls.groupUpdate.push([id, p]); } },
  };
  // Modules read `browser` from wxt/browser, which Vitest aliases to this fake object.
  for (const ns of ['runtime', 'windows', 'tabs', 'tabGroups']) fakeBrowser[ns] = api[ns];
}

const sample = () => [{
  state: 'normal', left: 1, top: 2, width: 800, height: 600, focused: true,
  ungroupedTabs: [
    { url: 'https://a.com/', title: 'A', index: 0, pinned: false },
    { url: 'javascript:alert(1)', title: 'bad', index: 3, pinned: false },
    { url: 'https://d.com/', title: 'D', index: 4, pinned: false, active: true },
    { url: 'https://open.example/', title: 'open', index: 5, pinned: false },
    { url: 'about:blank', title: 'blank', index: 6, pinned: false },
  ],
  groups: [{
    title: 'G', color: 'blue', collapsed: true,
    tabs: [
      { url: 'https://b.com/', title: 'B', index: 1, pinned: true },
      { url: 'https://c.com/', title: 'C', index: 2, pinned: false },
      { url: 'https://a.com/#dup', title: 'dup', index: 7, pinned: false },
    ],
  }],
}];

const chromium = { tabGroups: true, groupColors: true, groupCollapse: true, discard: true, discardOnCreate: false, bookmarks: true };
const firefox = { ...chromium, discardOnCreate: true };
const noGroups = { ...chromium, tabGroups: false, groupColors: false, groupCollapse: false };

const info = (family, features): BrowserInfo => ({ key: 'chrome', name: 'test', family, features });

async function run(features, family, opts = {}) {
  installChrome(!!features.discardOnCreate);
  const failures = [];
  const progress = [];
  const a = new TabAdapter(info(family, features));
  const res = await a.importWindows(sample(), {
    skipOpenTabs: true, focusRestored: true,
    onFailure: (f) => failures.push(f),
    onProgress: (d, m) => progress.push([d, m]),
    ...opts,
  });
  return { res, failures, progress };
}

beforeEach(() => {
  createFakeBrowser(); // quiets console and resets wxt's fake between tests
});

describe('TabAdapter.importWindows (Chromium)', () => {
  it('restores order, pins, layout, groups and discards background tabs', async () => {
    const { res, failures, progress } = await run(chromium, 'chromium');
    expect(calls.create.map((c) => c.index)).toEqual([0, 1, 2, 3]);
    expect(calls.create.map((c) => c.url)).toEqual(['https://b.com/', 'https://a.com/', 'https://c.com/', 'https://d.com/']);
    expect(calls.create[0].pinned).toBe(true);
    expect(calls.wcreate[0].focused).toBe(false);
    expect(calls.wcreate[0].width).toBe(800);
    expect([res.tabs, res.failed, res.skipped, res.groups]).toEqual([4, 1, 3, 1]);
    expect(failures.length).toBe(1);
    expect(failures[0].reason).toBe('unsafe-scheme');
    // pinned B is not grouped; only C is
    expect(calls.group.length).toBe(1);
    expect(calls.group[0].tabIds.length).toBe(1);
    expect(calls.group[0].createProperties).toEqual({ windowId: 100 });
    expect(calls.groupUpdate[0][1]).toEqual({ title: 'G', collapsed: true, color: 'blue' });
    expect(calls.remove, 'default tab removed').toEqual([101]);
    expect(calls.discard.length).toBe(3);
    expect(calls.discard, 'active tab not discarded').not.toContain(calls.update[0][0]);
    expect(calls.update[0][1]).toEqual({ active: true });
    expect(progress.at(-1)[0]).toBe(8);
  });

  it('tabs.group is called with createProperties.windowId, never a top-level windowId (regression)', async () => {
    await run(chromium, 'chromium');
    for (const g of calls.group) {
      expect('windowId' in g).toBe(false);
      expect(Object.keys(g).sort()).toEqual(['createProperties', 'tabIds']);
    }
  });

  it('lazy mode creates placeholder URLs and discards nothing', async () => {
    await run(chromium, 'chromium', { restoreMode: 'lazy' });
    expect(calls.create[1].url.startsWith('chrome-extension://abc/lazy.html?url=')).toBe(true);
    expect(calls.discard.length).toBe(0);
  });

  it('lazy URLs start with runtime.getURL(LAZY_PAGE_PATH)', async () => {
    expect(LAZY_PAGE_PATH).toBe('/lazy.html');
    await run(chromium, 'chromium', { restoreMode: 'lazy' });
    const base = browser.runtime.getURL(LAZY_PAGE_PATH as never);
    expect(calls.create[1].url.startsWith(`${base}?url=`)).toBe(true);
    const q = new URL(calls.create[1].url).searchParams;
    expect(q.get('url')).toBe('https://a.com/');
    expect(q.get('title')).toBe('A');
    expect(q.get('favicon')).toBe('');
    // the active tab is created with its real URL
    expect(calls.create[3].url).toBe('https://d.com/');
  });

  it('reports a group failure without aborting', async () => {
    installChrome(false);
    const failures = [];
    failGroupFor = 104;
    const a = new TabAdapter(info('chromium', chromium));
    const res = await a.importWindows(sample(), { skipOpenTabs: true, onFailure: (f) => failures.push(f) });
    expect(failures.some((f) => f.kind === 'group')).toBe(true);
    expect(res.groups).toBe(0);
  });

  it('without tab-group support each group becomes its own window', async () => {
    const { res } = await run(noGroups, 'chromium');
    expect(calls.group.length).toBe(0);
    expect(calls.wcreate.length).toBe(2);
    expect(res.windows).toBe(2);
    expect(res.groups).toBe(1);
    expect(calls.remove.length).toBe(2);
    expect(calls.create.map((c) => c.url).slice(-2), 'pinned first').toEqual(['https://b.com/', 'https://c.com/']);
  });
});

describe('TabAdapter.importWindows (Firefox)', () => {
  it('creates discarded tabs directly with titles', async () => {
    const { res } = await run(firefox, 'gecko');
    expect(calls.create[0].pinned).toBe(true);
    expect(calls.create[0].discarded).toBeUndefined();
    expect(calls.create[1].discarded).toBe(true);
    expect(calls.create[1].title).toBe('A');
    expect(calls.create[3].discarded, 'active tab is loaded').toBeUndefined();
    expect(calls.discard.length).toBe(0);
    expect(res.tabs).toBe(4);
  });
});

describe('TabAdapter cancellation and cleanup', () => {
  it('cancelling mid-way still cleans up the default tab', async () => {
    installChrome(false);
    let n = 0;
    const a = new TabAdapter(info('chromium', chromium));
    const res = await a.importWindows(sample(), { isCancelled: () => n++ >= 2 });
    expect(res.cancelled).toBe(true);
    expect(calls.remove.length).toBe(1);
  });

  it('a window with only invalid tabs is never created', async () => {
    installChrome(false);
    const a = new TabAdapter(info('chromium', chromium));
    const r = await a.importWindows([{ ungroupedTabs: [{ url: 'javascript:1', title: '', pinned: false }], groups: [] }], {});
    expect(calls.wcreate.length).toBe(0);
    expect(r.failed).toBe(1);
  });

  it('removes the window when every tab fails to create', async () => {
    installChrome(false);
    fakeBrowser.tabs.create = async () => { throw new Error('nope'); };
    const a = new TabAdapter(info('chromium', chromium));
    const r = await a.importWindows([{ ungroupedTabs: [{ url: 'https://x.com/', title: '', pinned: false }], groups: [] }], {});
    expect(r.failed).toBe(1);
    expect(calls.wremove).toEqual([100]);
    expect(calls.remove.length).toBe(0);
  });
});

describe('TabAdapter against the strict fake browser', () => {
  const backup = () => [{
    ungroupedTabs: [
      { url: 'https://pinned.example/', title: '', index: 0, pinned: true },
      { url: 'https://a.example/', title: '', index: 1, pinned: false },
    ],
    groups: [{ title: 'Work', color: 'blue', collapsed: false, tabs: [
      { url: 'https://g1.example/', title: '', index: 2, pinned: false },
      { url: 'https://g2.example/', title: '', index: 3, pinned: false }] }],
  }];

  it('restores a group on Chromium (tabs.group rejects unknown properties)', async () => {
    const fb = createFakeBrowser({ family: 'chromium' });
    const failures = [];
    const res = await new TabAdapter(info('chromium', { ...chromium })).importWindows(backup(), {
      restoreMode: 'eager', // unknown modes fall back to the default
      onFailure: (f) => failures.push(f),
    });
    expect(failures).toEqual([]);
    expect(res.groups).toBe(1);
    expect(fb.calls.tabsGroup.length).toBe(1);
    expect(Object.keys(fb.calls.tabsGroup[0]).sort()).toEqual(['createProperties', 'tabIds']);
    const [g] = [...fb.groups.values()];
    expect(g.title).toBe('Work');
    expect(g.color).toBe('blue');
  });

  it('restores Firefox-style: background tabs created discarded with a title', async () => {
    const fb = createFakeBrowser({ family: 'gecko' });
    const failures = [];
    const res = await new TabAdapter(info('gecko', { ...firefox, tabGroups: false, groupColors: false, groupCollapse: false }))
      .importWindows(
        [{ ungroupedTabs: [
          { url: 'https://a.example/', title: 'A', pinned: false, active: true },
          { url: 'https://b.example/', title: 'B', pinned: false }], groups: [] }],
        { onFailure: (f) => failures.push(f) },
      );
    expect(failures).toEqual([]);
    expect(res.tabs).toBe(2);
    expect(fb.calls.tabsCreate[1].discarded).toBe(true);
    expect(fb.calls.tabsCreate[1].title).toBe('B');
  });
});
