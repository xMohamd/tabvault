// @ts-nocheck -- adapter stubs are deliberately partial.
import { beforeEach, describe, expect, it } from 'vitest';
import type { BrowserInfo } from '../src/lib/browser-detect';
import { UniversalImporter } from '../src/lib/importer';
import { BackupFormatError } from '../src/lib/schema';
import { createFakeBrowser } from './helpers/fake-browser';

beforeEach(() => {
  createFakeBrowser();
});

const browser = { key: 'chrome', name: 'Chrome', family: 'chromium', features: { bookmarks: true } } as BrowserInfo;
const backup = () => ({
  windows: [{ ungroupedTabs: [{ url: 'https://a.com' }, { url: 'javascript:1' }] }],
  bookmarks: [{ title: 'b', url: 'https://b.com' }],
});
const opts = (o) => ({ importTabs: false, importBookmarks: false, ...o });

function importerWith(adapter) {
  const imp = new UniversalImporter({ browser, bookmarksAdapter: adapter });
  // Stub the tab phase so these tests only exercise orchestration.
  imp.tabAdapter = {
    importWindows: async (_w, o) => {
      o.onProgress?.(1, 'tab');
      o.onFailure?.({ kind: 'tab', title: 't', reason: 'unsafe-scheme' });
      return { tabs: 1, groups: 0, windows: 1, skipped: 0, failed: 1, cancelled: false };
    },
  };
  return imp;
}
const goodAdapter = () => ({
  import: async (_n, o) => { o.onFailure({ title: 'x', reason: 'r' }); return { created: 2, skipped: 1, failed: 1, cancelled: false }; },
});

describe('UniversalImporter', () => {
  it('combines bookmark and tab results and failures', async () => {
    const progress = [];
    const r = await importerWith(goodAdapter()).import(backup(), opts({
      importTabs: true, importBookmarks: true, onProgress: (p) => progress.push(`${p.phase}:${p.current}/${p.total}`),
    }));
    expect(r.bookmarks).toBe(2);
    expect(r.bookmarksSkipped).toBe(1);
    expect(r.bookmarksFailed).toBe(1);
    expect(r.tabs).toBe(1);
    expect(r.tabsFailed).toBe(1);
    expect(r.failures.map((f) => f.kind)).toEqual(['bookmark', 'tab']);
    expect(progress.at(-1)).toBe('done:1/1');
    expect(progress).toContain('bookmarks:0/0');
    expect(progress).toContain('tabs:1/2');
  });

  it('aborts a replace when beforeReplace (the safety snapshot) fails', async () => {
    let called = false;
    const adapter = { import: async () => { called = true; return {}; } };
    const r = await importerWith(adapter).import(backup(), opts({
      importBookmarks: true, bookmarkStrategy: 'replace',
      beforeReplace: async () => { throw new Error('no'); },
    }));
    expect(called).toBe(false);
    expect(r.bookmarks).toBe(0);
    expect(r.errors[0]).toMatch(/nothing was replaced: no/);
  });

  it('runs beforeReplace only for the replace strategy', async () => {
    let n = 0;
    const imp = importerWith(goodAdapter());
    await imp.import(backup(), opts({ importBookmarks: true, bookmarkStrategy: 'merge', beforeReplace: async () => { n++; } }));
    await imp.import(backup(), opts({ importBookmarks: true, bookmarkStrategy: 'replace', beforeReplace: async () => { n++; } }));
    expect(n).toBe(1);
  });

  it('reports an error when the browser has no bookmarks API', async () => {
    const imp = new UniversalImporter({
      browser: { key: 'safari', name: 'Safari', family: 'webkit', features: { bookmarks: false } },
      bookmarksAdapter: goodAdapter(),
    });
    const r = await imp.import(backup(), opts({ importBookmarks: true }));
    expect(r.bookmarks).toBe(0);
    expect(r.errors[0]).toMatch(/no bookmarks API/);
  });

  it('turns adapter exceptions into errors instead of throwing', async () => {
    const imp = importerWith({ import: async () => { throw new Error('adapter down'); } });
    imp.tabAdapter.importWindows = async () => { throw new Error('tabs down'); };
    const r = await imp.import(backup(), opts({ importBookmarks: true, importTabs: true }));
    expect(r.errors.length).toBe(2);
    expect(r.errors[0]).toMatch(/adapter down/);
    expect(r.errors[1]).toMatch(/tabs down/);
  });

  it('skips the tab phase when cancelled during bookmarks', async () => {
    let tabsRun = false;
    const imp = importerWith({ import: async () => ({ created: 0, skipped: 0, failed: 0, cancelled: true }) });
    imp.tabAdapter.importWindows = async () => { tabsRun = true; return {}; };
    const r = await imp.import(backup(), opts({ importBookmarks: true, importTabs: true }));
    expect(r.cancelled).toBe(true);
    expect(tabsRun).toBe(false);
  });

  it('caps stored failures at 500', async () => {
    const imp = importerWith({
      import: async (_n, o) => { for (let i = 0; i < 700; i++) o.onFailure({ title: String(i), reason: 'r' }); return { created: 0, skipped: 0, failed: 700 }; },
    });
    const r = await imp.import(backup(), opts({ importBookmarks: true }));
    expect(r.failures.length).toBe(500);
    expect(r.bookmarksFailed).toBe(700);
  });

  it('rejects input that is not a backup', async () => {
    const imp = importerWith(goodAdapter());
    await expect(imp.import(5, opts({}))).rejects.toBeInstanceOf(BackupFormatError);
    await expect(imp.import({ foo: 1 }, opts({}))).rejects.toBeInstanceOf(BackupFormatError);
  });

  it('reports normalisation warnings', async () => {
    const r = await importerWith(goodAdapter()).import(
      { schemaVersion: '2.0', windows: [{ ungroupedTabs: [{ url: '' }, { url: 'https://a.com' }] }] },
      opts({}),
    );
    expect(r.warnings.newerSchema).toBe(true);
    expect(r.warnings.invalidTabs).toBe(1);
  });
});

describe('UniversalImporter (real adapters, strict fake browser)', () => {
  it('round-trips tabs and bookmarks into a fresh Chromium', async () => {
    const fb = createFakeBrowser({ family: 'chromium' });
    const info = {
      key: 'chrome', name: 'Chrome', family: 'chromium',
      features: { tabGroups: true, groupColors: true, groupCollapse: true, discard: true, discardOnCreate: false, bookmarks: true },
    };
    const home = fb.seedWindow({ focused: true }, ['chrome://newtab/']);
    const res = await new UniversalImporter({ browser: info }).import(
      {
        windows: [{ ungroupedTabs: [{ url: 'https://a.example/', index: 0 }],
          groups: [{ title: 'G', color: 'red', tabs: [{ url: 'https://b.example/', index: 1 }, { url: 'https://c.example/', index: 2 }] }] }],
        bookmarks: [{ title: 'bm', url: 'https://bm.example/' }],
      },
      opts({ importTabs: true, importBookmarks: true }),
    );
    expect(res.errors).toEqual([]);
    expect([res.tabs, res.groups, res.windows, res.bookmarks]).toEqual([3, 1, 1, 1]);
    const restored = [...fb.windows.values()].find((w) => w.id !== home.window.id);
    expect(fb.tabUrls(restored.id)).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
    expect(fb.calls.tabsGroup.every((c) => !('windowId' in c))).toBe(true);
  });
});
