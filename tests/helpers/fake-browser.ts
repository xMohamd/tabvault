// @ts-nocheck -- untyped in-memory fake (ported JS); test code consumes it as `any`.
/**
 * In-memory fake browser for tests (TypeScript port of the reference repo's helper).
 *
 *   const fb = createFakeBrowser({ family: 'chromium' });
 *   // modules importing `browser` from 'wxt/browser' now see fb.chrome's APIs
 *
 * In Vitest, WXT aliases `wxt/browser` to `fakeBrowser` (wxt/testing/fake-browser).
 * `install()` replaces that object's namespaces with these stricter fakes, so
 * regressions such as a top-level `windowId` in tabs.group fail loudly.
 *
 * Set DEBUG=1 to see the extension's console output while running tests.
 */
import { fakeBrowser } from 'wxt/testing/fake-browser';
export const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
export const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

const clone = (v: any): any => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Silences the extension logger's console output unless DEBUG is set. Idempotent. */
export function quietConsole() {
    if (process.env.DEBUG) return;
    for (const k of ['debug', 'info', 'warn', 'error'] as const) console[k] = () => {};
}

export interface FakeBrowserOptions {
    userAgent?: string;
    family?: 'chromium' | 'gecko';
    withTabGroups?: boolean;
    withBookmarks?: boolean;
}

export function createFakeBrowser({
    userAgent,
    family = 'chromium',
    withTabGroups = true,
    withBookmarks = true,
}: FakeBrowserOptions = {}) {
    quietConsole();
    const gecko = family === 'gecko';
    const ua = userAgent ?? (gecko ? FIREFOX_UA : CHROME_UA);

    let nextId = 100;
    const id = () => nextId++;
    const listeners = { onUpdated: [], onMessage: [], onAlarm: [], onInstalled: [], onStartup: [] };
    const event = (key) => ({
        addListener: (f) => { listeners[key].push(f); },
        removeListener: (f) => { listeners[key] = listeners[key].filter((x) => x !== f); },
        hasListener: (f) => listeners[key].includes(f),
    });

    const windows = new Map(); // id -> { ...props, tabIds: [] }
    const tabs = new Map();
    const groups = new Map();
    const bookmarks = new Map(); // id -> node (children hold node references)
    const store = { local: {}, session: {} };
    const alarms = new Map();
    const downloads = [];
    const calls = { tabsGroup: [], tabsCreate: [], windowsCreate: [] };

    // ---- windows & tabs ----
    const reindex = (w) => w.tabIds.forEach((tid, i) => { tabs.get(tid).index = i; });
    const snapshotWin = (w) => ({ ...w, tabIds: undefined, tabs: w.tabIds.map((tid) => ({ ...tabs.get(tid) })) });

    function addTab(windowId, props = {}) {
        const w = windows.get(windowId);
        if (!w) throw new Error(`No window with id: ${windowId}`);
        const tid = id();
        const url = props.url ?? 'chrome://newtab/';
        const t = {
            id: tid, windowId, url: '', pendingUrl: url, title: props.title ?? '',
            pinned: !!props.pinned, active: !!props.active, groupId: -1,
            discarded: !!props.discarded, incognito: w.incognito, index: 0, status: 'loading',
        };
        tabs.set(tid, t);
        const idx = props.index ?? w.tabIds.length;
        w.tabIds.splice(Math.max(0, Math.min(idx, w.tabIds.length)), 0, tid);
        reindex(w);
        return t;
    }
    const finishLoad = (t) => {
        t.url = t.pendingUrl; t.pendingUrl = undefined; t.status = 'complete';
        listeners.onUpdated.forEach((f) => f(t.id, { url: t.url, status: 'complete' }, { ...t }));
    };

    function addWindow(opts = {}) {
        const wid = id();
        const w = {
            id: wid, type: opts.type ?? 'normal', focused: !!opts.focused, incognito: !!opts.incognito,
            state: opts.state ?? 'normal', left: opts.left ?? 0, top: opts.top ?? 0,
            width: opts.width ?? 1200, height: opts.height ?? 800, tabIds: [],
        };
        windows.set(wid, w);
        return w;
    }

    /** Seeds a window with tabs; tabs are fully loaded (no timers). */
    function seedWindow(winOpts = {}, tabSpecs = []) {
        const w = addWindow(winOpts);
        const created = tabSpecs.map((spec) => {
            const s = typeof spec === 'string' ? { url: spec } : spec;
            const t = addTab(w.id, s);
            t.url = t.pendingUrl; t.pendingUrl = undefined; t.status = 'complete';
            return t;
        });
        return { window: w, tabs: created };
    }
    function seedTab(windowId, spec) {
        const s = typeof spec === 'string' ? { url: spec } : spec;
        const t = addTab(windowId, s);
        t.url = t.pendingUrl; t.pendingUrl = undefined; t.status = 'complete';
        return t;
    }
    /** Groups existing tabs (bypasses API strictness). */
    function seedGroup(tabIds, { title = '', color = 'grey', collapsed = false } = {}) {
        const gid = id();
        const windowId = tabs.get(tabIds[0]).windowId;
        groups.set(gid, { id: gid, windowId, title, color, collapsed });
        tabIds.forEach((tid) => { tabs.get(tid).groupId = gid; });
        return gid;
    }

    // ---- bookmarks ----
    const roots = {};
    function addBm(node) {
        bookmarks.set(node.id, node);
        if (node.parentId) bookmarks.get(node.parentId).children.push(node);
        return node;
    }
    function installRoots() {
        addBm({ id: gecko ? 'root________' : '0', title: '', children: [] });
        const rootId = gecko ? 'root________' : '0';
        const defs = gecko
            ? [['menu________', 'Bookmarks Menu', undefined, 'menu'], ['toolbar_____', 'Bookmarks Toolbar', undefined, 'bar'],
                ['unfiled_____', 'Other Bookmarks', undefined, 'other'], ['mobile______', 'Mobile Bookmarks', undefined, 'mobile']]
            : [['1', 'Bookmarks bar', 'bookmarks-bar', 'bar'], ['2', 'Other bookmarks', 'other', 'other'],
                ['3', 'Mobile bookmarks', 'mobile', 'mobile']];
        for (const [rid, title, folderType, key] of defs) {
            addBm({ id: rid, parentId: rootId, title, ...(folderType ? { folderType } : {}), children: [] });
            roots[key] = rid;
        }
        roots.root = rootId;
    }
    const defaultParent = () => (gecko ? 'unfiled_____' : '2');
    function seedBookmark(parentId, spec) {
        const n = { id: spec.id ?? String(id()), parentId, title: spec.title ?? '' };
        if (spec.url) n.url = spec.url;
        else if (spec.type === 'separator') n.type = 'separator';
        else n.children = [];
        addBm(n);
        (spec.children ?? []).forEach((c) => seedBookmark(n.id, c));
        return n;
    }
    function removeBm(bid, tree) {
        const n = bookmarks.get(bid);
        if (!n) throw new Error('Can\'t find bookmark for id.');
        if (!n.parentId) throw new Error('Can\'t modify the root bookmark folders.');
        if (n.children?.length && !tree) throw new Error('Can\'t remove non-empty folder (use recursive removal instead).');
        const p = bookmarks.get(n.parentId);
        p.children = p.children.filter((c) => c.id !== bid);
        const drop = (x) => { bookmarks.delete(x.id); (x.children ?? []).forEach(drop); };
        drop(n);
    }

    // ---- storage ----
    const area = (k) => ({
        get: async (key) => {
            if (key == null) return clone(store[k]);
            const keys = typeof key === 'string' ? [key] : Array.isArray(key) ? key : Object.keys(key);
            const out = {};
            for (const x of keys) if (x in store[k]) out[x] = clone(store[k][x]);
            return out;
        },
        set: async (o) => { Object.assign(store[k], clone(o)); },
        remove: async (key) => { [].concat(key).forEach((x) => delete store[k][x]); },
        clear: async () => { store[k] = {}; },
    });

    const noExtra = (obj, allowed, where) => {
        for (const k of Object.keys(obj ?? {})) {
            if (!allowed.includes(k)) throw new Error(`Error in invocation of ${where}: Unexpected property: '${k}'.`);
        }
    };

    // ---- chrome.* ----
    const api = {
        runtime: {
            id: 'fake-extension-id',
            getManifest: () => ({ version: '1.1.0' }),
            getURL: (p) => `${gecko ? 'moz-extension' : 'chrome-extension'}://fake-extension-id/${p}`,
            onMessage: event('onMessage'), onInstalled: event('onInstalled'), onStartup: event('onStartup'),
            sendMessage: async () => {},
            getPlatformInfo: async () => ({ os: 'linux' }),
        },
        windows: {
            getAll: async (info = {}) => [...windows.values()]
                .filter((w) => !info.windowTypes || info.windowTypes.includes(w.type))
                .map((w) => (info.populate ? snapshotWin(w) : { ...w, tabIds: undefined })),
            create: async (o = {}) => {
                calls.windowsCreate.push(clone(o));
                const w = addWindow(o);
                const t = addTab(w.id, { url: 'chrome://newtab/', active: true });
                finishLoad(t);
                return snapshotWin(w);
            },
            remove: async (wid) => {
                const w = windows.get(wid);
                if (!w) throw new Error(`No window with id: ${wid}`);
                w.tabIds.forEach((tid) => tabs.delete(tid));
                windows.delete(wid);
            },
            update: async (wid, p) => {
                const w = windows.get(wid);
                if (!w) throw new Error(`No window with id: ${wid}`);
                Object.assign(w, p);
                return { ...w, tabIds: undefined };
            },
        },
        tabs: {
            create: async (o = {}) => {
                calls.tabsCreate.push(clone(o));
                const allowed = ['windowId', 'url', 'pinned', 'active', 'index', ...(gecko ? ['discarded', 'title'] : [])];
                noExtra(o, allowed, 'tabs.create');
                if (/^javascript:/i.test(o.url ?? '')) throw new Error('Cannot create a tab with a javascript: URL.');
                const t = addTab(o.windowId ?? [...windows.keys()][0], o);
                if (o.discarded) finishLoad(t);
                else setTimeout(() => finishLoad(t), 1);
                return { ...t };
            },
            query: async () => [...tabs.values()].map((t) => ({ ...t })),
            get: async (tid) => {
                if (!tabs.has(tid)) throw new Error(`No tab with id: ${tid}.`);
                return { ...tabs.get(tid) };
            },
            update: async (tid, p) => {
                if (!tabs.has(tid)) throw new Error(`No tab with id: ${tid}.`);
                Object.assign(tabs.get(tid), p);
                return { ...tabs.get(tid) };
            },
            remove: async (ids) => {
                for (const tid of [].concat(ids)) {
                    const t = tabs.get(tid);
                    if (!t) throw new Error(`No tab with id: ${tid}.`);
                    const w = windows.get(t.windowId);
                    w.tabIds = w.tabIds.filter((x) => x !== tid);
                    reindex(w);
                    tabs.delete(tid);
                }
            },
            discard: async (tid) => {
                const t = tabs.get(tid);
                if (!t) throw new Error(`No tab with id: ${tid}.`);
                if (t.active) return undefined; // real browsers refuse to discard the active tab
                t.discarded = true;
                return { ...t };
            },
            onUpdated: event('onUpdated'),
        },
        bookmarks: {
            getTree: async () => [clone(bookmarks.get(roots.root))],
            getChildren: async (bid) => {
                const n = bookmarks.get(bid);
                if (!n) throw new Error('Can\'t find bookmark for id.');
                return clone(n.children ?? []);
            },
            create: async (o) => {
                noExtra(o, ['parentId', 'index', 'title', 'url', ...(gecko ? ['type'] : [])], 'bookmarks.create');
                const parentId = o.parentId ?? defaultParent();
                const p = bookmarks.get(parentId);
                if (!p || !p.children) throw new Error('Parent folder not found.');
                if (o.url !== undefined && !/^[a-z][a-z0-9+.-]*:/i.test(o.url)) throw new Error('Invalid URL.');
                const n = { id: String(id()), parentId, title: o.title ?? '' };
                if (o.type === 'separator') n.type = 'separator';
                else if (o.url !== undefined) n.url = o.url;
                else n.children = [];
                return clone(addBm(n));
            },
            remove: async (bid) => removeBm(bid, false),
            removeTree: async (bid) => removeBm(bid, true),
        },
        tabGroups: {
            query: async () => [...groups.values()].map((g) => ({ ...g })),
            update: async (gid, p) => {
                if (!groups.has(gid)) throw new Error(`No group with id: ${gid}.`);
                Object.assign(groups.get(gid), p);
                return { ...groups.get(gid) };
            },
        },
        downloads: { download: async (o) => { downloads.push(o); return downloads.length; } },
        storage: { local: area('local'), session: area('session') },
        alarms: {
            get: async (n) => alarms.get(n),
            create: async (n, o) => { alarms.set(n, { name: n, ...o }); },
            clear: async (n) => alarms.delete(n),
            onAlarm: event('onAlarm'),
        },
    };

    // Strict tabs.group: Chrome rejects unknown properties such as a top-level `windowId`.
    api.tabs.group = async (o = {}) => {
        calls.tabsGroup.push(clone(o));
        noExtra(o, ['tabIds', 'groupId', 'createProperties'], 'tabs.group');
        noExtra(o.createProperties, ['windowId'], 'tabs.group');
        const tabIds = [].concat(o.tabIds ?? []);
        if (tabIds.length === 0) throw new Error('at least one tab id is required');
        for (const tid of tabIds) {
            const t = tabs.get(tid);
            if (!t) throw new Error(`No tab with id: ${tid}.`);
            if (t.pinned) throw new Error('Tabs cannot be edited right now / pinned tabs cannot be grouped.');
        }
        if (o.groupId !== undefined) {
            if (!groups.has(o.groupId)) throw new Error(`No group with id: ${o.groupId}.`);
            tabIds.forEach((tid) => { tabs.get(tid).groupId = o.groupId; });
            return o.groupId;
        }
        const windowId = o.createProperties?.windowId ?? tabs.get(tabIds[0]).windowId;
        if (!windows.has(windowId)) throw new Error(`No window with id: ${windowId}`);
        const gid = id();
        groups.set(gid, { id: gid, windowId, title: '', color: 'grey', collapsed: false });
        tabIds.forEach((tid) => { tabs.get(tid).groupId = gid; });
        return gid;
    };
    if (!withTabGroups) { delete api.tabs.group; delete api.tabGroups; }
    if (!withBookmarks) delete api.bookmarks;

    function install() {
        // Replace namespaces on WXT's fake so modules importing `browser` see these fakes.
        const target = fakeBrowser as any;
        for (const ns of ['runtime', 'windows', 'tabs', 'tabGroups', 'bookmarks', 'downloads', 'storage', 'alarms']) {
            target[ns] = (api as any)[ns];
        }
        (globalThis as any).chrome = api;
        (globalThis as any).browser = api;
        Object.defineProperty(globalThis, 'navigator', {
            value: { userAgent: ua }, configurable: true, writable: true,
        });
    }

    function reset() {
        windows.clear(); tabs.clear(); groups.clear(); bookmarks.clear(); alarms.clear();
        downloads.length = 0; store.local = {}; store.session = {};
        for (const k of Object.keys(calls)) calls[k].length = 0;
        for (const k of Object.keys(listeners)) listeners[k] = [];
        nextId = 100;
        installRoots();
        install();
    }

    reset();

    return {
        chrome: api, family, userAgent: ua,
        windows, tabs, groups, bookmarks, roots, storage: store, alarms, downloads, listeners, calls,
        seedWindow, seedTab, seedGroup, seedBookmark, reset,
        /** Convenience: ids of a window's tabs in order. */
        tabUrls: (wid) => windows.get(wid).tabIds.map((tid) => tabs.get(tid).url || tabs.get(tid).pendingUrl),
        /** Wait for pending tab-load timers. */
        settle: (ms = 10) => new Promise((r) => setTimeout(r, ms)),
    };
}
