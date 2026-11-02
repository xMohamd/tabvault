// @ts-nocheck -- ported JS scenario against the untyped fake browser.
/**
 * End-to-end: real modules (exporter, importer, adapters, scheduler, background entrypoint) against one
 * in-memory fake browser. Tests run in order and share state, like a user session would.
 */
import { describe, it, beforeAll as before } from 'vitest';
import assert from 'node:assert/strict';
import { createFakeBrowser } from './helpers/fake-browser';
import { UniversalExporter } from '@/lib/exporter';
import { UniversalImporter } from '@/lib/importer';
import { detectBrowserAsync, detectBrowser } from '@/lib/browser-detect';
import * as sched from '@/lib/backup-scheduler';
import background from '@/entrypoints/background';

let fb = createFakeBrowser({ family: 'chromium' });
delete URL.createObjectURL; // force the background's data: URL download path (Chrome service worker)
background.main(); // registers listeners on the fake

const filters = { excludeInternal: true };
let browser;
let data;

function seedSource() {
    const w1 = fb.seedWindow({ focused: true }, [
        { url: 'https://pinned.example/', pinned: true },
        'https://a.example/',
        'https://g1.example/1',
        { url: 'https://g1.example/2', active: true },
        'https://b.example/',
        'chrome://settings/',
    ]);
    const w2 = fb.seedWindow({ state: 'maximized' }, [
        'chrome-extension://sus/suspended.html#ttl=x&uri=https://suspended.example/page',
        'https://github.com/x',
    ]);
    fb.seedGroup([w1.tabs[2].id, w1.tabs[3].id], { title: 'Work', color: 'blue' });
    fb.seedBookmark(fb.roots.bar, { title: 'Bar link', url: 'https://bar.example/' });
    fb.seedBookmark(fb.roots.other, { title: 'Folder', children: [{ title: 'Nested', url: 'https://nested.example/' }] });
    return { w1, w2 };
}

function wipeWindows() {
    fb.windows.clear(); fb.tabs.clear(); fb.groups.clear();
}

describe('Chromium round trip', () => {
    before(async () => {
        seedSource();
        browser = await detectBrowserAsync();
    });

    it('probes the browser from the fake APIs', () => {
        assert.equal(browser.key, 'chrome');
        assert.equal(browser.family, 'chromium');
        assert.ok(browser.features.tabGroups && browser.features.bookmarks && browser.features.alarms);
    });

    it('exports windows, groups, layout and unwraps placeholders', async () => {
        const out = await new UniversalExporter({ browser }).export({ includeTabs: true, includeBookmarks: true, filters });
        data = out.data;
        assert.equal(out.stats.tabs, 7);
        assert.equal(out.stats.windows, 2);
        assert.equal(data.windows[0].groups[0].title, 'Work');
        assert.equal(data.windows[0].groups[0].tabs.length, 2);
        assert.equal(data.windows[1].ungroupedTabs[0].url, 'https://suspended.example/page');
        assert.equal(data.windows[1].state, 'maximized');
    });

    let home;
    it('imports into a fresh browser: order, groups, default tabs, progress', async () => {
        wipeWindows();
        home = fb.seedWindow({ focused: true }, ['chrome://newtab/']);
        const progress = [];
        const res = await new UniversalImporter({ browser }).import(JSON.parse(JSON.stringify(data)), {
            importTabs: true, importBookmarks: true, bookmarkStrategy: 'merge', restoreMode: 'discard',
            onProgress: (p) => progress.push(p), isCancelled: () => false,
        });
        assert.deepEqual(res.errors, []);
        assert.deepEqual([res.tabs, res.groups, res.windows], [7, 1, 2]);
        assert.equal(res.bookmarks, 0, 'merging into the same browser creates nothing new');
        assert.ok(res.bookmarksSkipped >= 2);

        const restored = [...fb.windows.values()].filter((w) => w.id !== home.window.id);
        assert.deepEqual(fb.tabUrls(restored[0].id), [
            'https://pinned.example/', 'https://a.example/', 'https://g1.example/1', 'https://g1.example/2', 'https://b.example/',
        ]);
        for (const w of restored) {
            assert.ok(!fb.tabUrls(w.id).includes('chrome://newtab/'), 'default tab removed');
        }
        const [g] = [...fb.groups.values()];
        assert.deepEqual([g.title, g.color], ['Work', 'blue']);
        assert.equal(fb.calls.tabsGroup.every((c) => !('windowId' in c)), true, 'no top-level windowId in tabs.group');
        const last = progress.at(-1);
        assert.equal(last.current, last.total);
    });

    it('imports bookmarks into a folder', async () => {
        const res = await new UniversalImporter({ browser }).import(data, { importTabs: false, importBookmarks: true, bookmarkStrategy: 'folder' });
        assert.equal(res.bookmarks, 2);
    });

    it('scheduler snapshots through the real exporter', async () => {
        await sched.saveSettings({ enabled: true, frequency: 'daily', keep: 3 });
        assert.ok(fb.alarms.has(sched.SCHEDULE_ALARM));
        const s1 = await sched.createSnapshot('manual', { browser });
        assert.ok(s1.stats.tabs > 0);
        const snap = await sched.getSnapshot(s1.id);
        assert.ok(Array.isArray(snap.windows));
    });
});

describe('service worker messaging', () => {
    const handler = () => fb.listeners.onMessage[0];
    const call = (msg, sender = { id: 'fake-extension-id' }) => new Promise((resolve) => {
        const ret = handler()(msg, sender, resolve);
        if (ret !== true) resolve(undefined);
    });

    it('GET_STATE reports the browser', async () => {
        const st = await call({ type: 'GET_STATE' });
        assert.ok(st.ok);
        assert.equal(st.browser.key, 'chrome');
    });

    it('EXPORT downloads valid JSON', async () => {
        const ex = await call({ type: 'EXPORT', options: { includeTabs: true, includeBookmarks: false } });
        assert.ok(ex.ok, JSON.stringify(ex));
        const { url } = fb.downloads.at(-1);
        assert.ok(url.startsWith('data:application/json;base64,'));
        const decoded = JSON.parse(Buffer.from(url.split(',')[1], 'base64').toString('utf8'));
        assert.equal(decoded.schemaVersion, '1.1');
    });

    it('SNAPSHOTS_LIST lists snapshots', async () => {
        const list = await call({ type: 'SNAPSHOTS_LIST' });
        assert.ok(list.ok && list.snapshots.length >= 1);
    });

    it('IMPORT_START with replace snapshots first, rejects a second concurrent import, and finishes', async () => {
        const start = await call({ type: 'IMPORT_START', data, options: { importTabs: true, importBookmarks: true, bookmarkStrategy: 'replace' } });
        assert.ok(start.ok);
        const busy = await call({ type: 'IMPORT_START', data, options: {} });
        assert.equal(busy.ok, false);

        for (let i = 0; i < 200; i++) {
            await new Promise((r) => setTimeout(r, 20));
            const s = await call({ type: 'GET_STATE' });
            if (!['running', 'cancelling'].includes(s.importState.status)) break;
        }
        const fin = (await call({ type: 'GET_STATE' })).importState;
        assert.equal(fin.status, 'done', `${fin.status} ${fin.error ?? ''}`);
        assert.equal(fin.result?.bookmarks, 2, 'replace re-created bookmarks');
        const list = await call({ type: 'SNAPSHOTS_LIST' });
        assert.ok(list.snapshots.some((s) => s.reason === 'pre-replace'));
    });

    it('ignores messages from other extensions', async () => {
        const res = await new Promise((r) => {
            const ret = handler()({ type: 'GET_STATE' }, { id: 'evil' }, r);
            if (ret !== true) r('ignored');
        });
        assert.equal(res, 'ignored');
    });

    it('DIAGNOSTICS returns the log history', async () => {
        const diag = await call({ type: 'DIAGNOSTICS' });
        assert.ok(diag.ok && Array.isArray(diag.report.logs));
    });
});

describe('Chromium export restored into Firefox', () => {
    it('restores tabs and bookmarks with Firefox semantics', async () => {
        fb = createFakeBrowser({ family: 'gecko' });
        const ff = detectBrowser(); // sync detection: the async result is cached for Chrome
        assert.equal(ff.family, 'gecko');
        assert.equal(ff.features.discardOnCreate, true);
        const home = fb.seedWindow({ focused: true }, ['about:newtab']);

        const res = await new UniversalImporter({ browser: ff }).import(JSON.parse(JSON.stringify(data)), {
            importTabs: true, importBookmarks: true, bookmarkStrategy: 'merge', restoreMode: 'discard',
        });
        assert.deepEqual(res.errors, []);
        assert.equal(res.tabs, 7);
        assert.equal(res.windows, 2);
        assert.equal(res.groups, 1);
        const restored = [...fb.windows.values()].filter((w) => w.id !== home.window.id);
        assert.equal(restored.length, 2);
        assert.ok(restored.some((w) => fb.tabUrls(w.id).includes('https://suspended.example/page')));
        const nonActiveDiscarded = [...fb.tabs.values()].filter((t) => t.discarded);
        assert.ok(nonActiveDiscarded.length > 0, 'background tabs created discarded');

        const titles = (id) => fb.bookmarks.get(id).children.map((c) => c.title);
        assert.ok(titles(fb.roots.bar).includes('Bar link'), 'bar bookmark in toolbar');
        assert.ok(titles(fb.roots.other).includes('Folder'), 'other bookmarks in unfiled');
    });
});

describe('export preview', () => {
    it('EXPORT_PREVIEW counts without downloading', async () => {
        fb = createFakeBrowser({ family: 'chromium' });
        background.main();
        fb.seedWindow({}, ['https://a.example/', 'https://b.example/']);
        fb.seedBookmark(fb.roots.bar, { title: 'JS', url: 'javascript:void(0)' });
        const handler = fb.listeners.onMessage[0];
        const reply = await new Promise((resolve) => {
            handler({ type: 'EXPORT_PREVIEW', options: { includeTabs: true, includeBookmarks: true } }, { id: 'fake-extension-id' }, resolve);
        });
        assert.equal(reply.ok, true);
        assert.equal(reply.stats.tabs, 2);
        assert.equal(reply.stats.bookmarklets, 1);
        assert.equal(fb.downloads.length, 0);
    });
});
