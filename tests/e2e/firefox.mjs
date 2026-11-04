// Real-Firefox end-to-end test (not part of `pnpm test`). Port of smoke.mjs plus Firefox-specific checks.
//
//   pnpm build:firefox && node tests/e2e/firefox.mjs        (NO_HEADLESS=1 to watch, KEEP=1 to keep temp files)
//
// How it drives Firefox (puppeteer-core over WebDriver BiDi):
//  * The built extension is installed temporarily (browser.installExtension) with a pinned moz-extension UUID.
//  * BiDi refuses to navigate a tab to moz-extension://, and a web page cannot open one. So a tiny helper
//    extension (tests/e2e/firefox/helper-ext) relays "open this URL" from a 127.0.0.1 page to tabs.create().
//    Extension pages opened this way are ordinary tabs that puppeteer can evaluate in: `browser.*` is available
//    there, and messages to the product's background page go through browser.runtime.sendMessage.
//  * MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 is required for puppeteer to evaluate in a privileged extension page.
//  * Snap Firefox cannot see /tmp or dot-directories: all temp files live in a plain directory under $HOME.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(HERE, '..', '..', '.output', 'firefox-mv3');
const helperDir = join(HERE, 'firefox', 'helper-ext');
const FIREFOX = process.env.FIREFOX || '/usr/bin/firefox';
const GECKO_ID = '{7ee0807c-6729-4612-a8a7-897c09851973}';
const UUID = '7a3f1c52-9d4e-4b08-8e6a-2f5c0d1b9e47';
const EXT = `moz-extension://${UUID}`;
const HEADLESS = !process.env.NO_HEADLESS;

if (!existsSync(join(extDir, 'manifest.json'))) {
  console.error(`Missing ${extDir}. Run \`pnpm build:firefox\` first.`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, msg) => {
  console.log(cond ? 'ok  ' : 'FAIL', msg);
  if (!cond) failed++;
};
const note = (msg) => console.log('note', msg);
const short = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n)}…` : s;
};

/** Polls `fn` until it returns a truthy value; returns that value, or the last falsy one after the timeout. */
async function poll(fn, { timeout = 10_000, interval = 150 } = {}) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
    } catch (e) {
      last = undefined;
      if (Date.now() > end) throw e;
    }
    if (last || Date.now() > end) return last;
    await sleep(interval);
  }
}

/** A failing section must not stop the others. */
async function section(name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(false, `${name}: threw ${e?.stack?.split('\n').slice(0, 3).join(' | ') ?? e}`);
  }
}

// ---------- environment ----------
const work = mkdtempSync(join(homedir(), 'tm-e2e-'));
const profile = join(work, 'profile');
const dlDir = join(work, 'downloads');
mkdirSync(profile);
mkdirSync(dlDir);

const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<title>${req.url}</title><h1>${req.url}</h1>`);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

let browser;
const cleanup = async () => {
  try {
    await browser?.close();
  } catch {}
  server.close();
  if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
};
process.on('SIGINT', async () => {
  await cleanup();
  process.exit(130);
});

browser = await puppeteer.launch({
  browser: 'firefox',
  executablePath: FIREFOX,
  headless: HEADLESS,
  userDataDir: profile,
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  extraPrefsFirefox: {
    'extensions.webextensions.uuids': JSON.stringify({ [GECKO_ID]: UUID }),
    'browser.download.folderList': 2,
    'browser.download.dir': dlDir,
    'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
    'browser.download.manager.showWhenStarting': false,
    'browser.shell.checkDefaultBrowser': false,
  },
});
console.log(`browser ${await browser.version()} (${HEADLESS ? 'headless' : 'headed'})`);

// ---------- 1. install, open the extension page ----------
await browser.installExtension(helperDir);
const installedId = await browser.installExtension(extDir);
ok(installedId === GECKO_ID, `extension installed (${installedId})`);

const opener = await browser.newPage();
await opener.goto(`${base}/opener`);

const knownPages = new Set();
/** Opens a moz-extension:// URL in a new tab via the helper extension and returns its puppeteer Page. */
async function openExtPage(path) {
  const before = new Set(await browser.pages());
  for (let attempt = 0; attempt < 3; attempt++) {
    await opener.evaluate((u) => window.postMessage({ __tmOpen: u }, '*'), `${EXT}/${path}`);
    const page = await poll(
      async () => {
        for (const p of await browser.pages()) {
          if (before.has(p) || knownPages.has(p)) continue;
          const href = await p.evaluate(() => location.href).catch(() => '');
          if (href.startsWith(EXT)) return p;
        }
        return null;
      },
      { timeout: 6000 },
    );
    if (page) {
      knownPages.add(page);
      return page;
    }
  }
  throw new Error(`could not open ${path}`);
}

const pg = await openExtPage('popup.html?view=tab#import');
const send = (msg) => pg.evaluate((m) => browser.runtime.sendMessage(m), msg);
const ext = (fn, ...args) => pg.evaluate(fn, ...args);

await section('popup UI', async () => {
  const ready = await poll(() => ext(() => document.querySelectorAll('[role=tab]').length === 3), { timeout: 10_000 });
  const ui = await ext(() => ({
    title: document.title,
    tabs: [...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim()),
    badge: document.getElementById('browser-badge')?.textContent,
    errs: document.body.innerText.match(/__MSG|undefined/g),
  }));
  ok(ready && ui.tabs.length === 3 && !ui.errs, `popup UI ${JSON.stringify(ui)}`);
  ok(/firefox/i.test(ui.badge ?? ''), `browser badge says Firefox (${ui.badge})`);
});

// ---------- 2. GET_STATE ----------
await section('GET_STATE', async () => {
  const state = await send({ type: 'GET_STATE' });
  const f = state.browser?.features ?? {};
  ok(state.ok && state.browser.key === 'firefox' && state.browser.family === 'gecko', `GET_STATE browser ${state.browser?.key}/${state.browser?.family}`);
  ok(f.tabGroups && f.groupColors && f.groupCollapse && f.bookmarks && f.downloads && f.discard && f.discardOnCreate && f.alarms, `features ${JSON.stringify(f)}`);
  ok(state.importState?.status === 'idle', `import state idle (${state.importState?.status})`);
});

// ---------- 3. seed ----------
let seed;
await section('seed', async () => {
  seed = await ext(async (siteBase) => {
    const sleepIn = (ms) => new Promise((r) => setTimeout(r, ms));
    const w = await browser.windows.create({ url: `${siteBase}/p0.html`, focused: false });
    const ids = [];
    for (let i = 1; i <= 4; i++) {
      ids.push((await browser.tabs.create({ windowId: w.id, url: `${siteBase}/p${i}.html`, active: false })).id);
    }
    for (let i = 0; i < 100; i++) {
      const tabs = await browser.tabs.query({ windowId: w.id });
      if (tabs.length >= 5 && tabs.every((t) => t.status === 'complete' && t.title && t.url.startsWith(siteBase))) break;
      await sleepIn(150);
    }
    const out = { windowId: w.id, errors: [] };
    try {
      const gid = await browser.tabs.group({ tabIds: [ids[1], ids[2]], createProperties: { windowId: w.id } });
      await browser.tabGroups.update(gid, { title: 'Smoke', color: 'purple' });
      out.groupId = gid;
    } catch (e) {
      out.errors.push(`group: ${e}`);
    }
    try {
      await browser.tabs.update(ids[0], { pinned: true });
    } catch (e) {
      out.errors.push(`pin: ${e}`);
    }
    const [root] = await browser.bookmarks.getTree();
    out.rootChildren = root.children.map((c) => c.id);
    const bar = 'toolbar_____';
    await browser.bookmarks.create({ parentId: bar, title: 'Smoke BM', url: `${siteBase}/bm.html` });
    const folder = await browser.bookmarks.create({ parentId: bar, title: 'Smoke Folder' });
    await browser.bookmarks.create({ parentId: folder.id, title: 'Smoke Nested', url: `${siteBase}/nested.html` });
    try {
      await browser.bookmarks.create({ parentId: bar, type: 'separator' });
      out.separator = true;
    } catch (e) {
      out.separator = String(e);
    }
    try {
      await browser.bookmarks.create({ parentId: bar, title: 'Smoke JS', url: 'javascript:void(document.title)' });
      out.bookmarklet = true;
    } catch (e) {
      out.bookmarklet = String(e);
    }
    await browser.bookmarks.create({ parentId: 'unfiled_____', title: 'Smoke Doomed', url: `${siteBase}/doomed.html` });
    return out;
  }, base);
  ok(seed.windowId && seed.errors.length === 0, `seeded source window ${short(seed)}`);
  note(`Firefox bookmarks.create accepts javascript: URLs: ${seed.bookmarklet === true ? 'yes' : `NO (${seed.bookmarklet})`}`);
  note(`Firefox bookmarks.create accepts separators: ${seed.separator === true ? 'yes' : `NO (${seed.separator})`}`);
});
const bookmarkletSeeded = seed?.bookmarklet === true;

// ---------- 4. preview, snapshot, schedule ----------
const exportOptions = { includeTabs: true, includeBookmarks: true, filters: { excludeInternal: true } };
let snapData;
await section('preview/snapshot/schedule', async () => {
  const prev = await send({ type: 'EXPORT_PREVIEW', options: exportOptions });
  const s = prev.stats ?? {};
  ok(prev.ok && s.tabs >= 5 && s.groups === 1 && s.windows >= 1 && s.bookmarks >= 3, `EXPORT_PREVIEW ${short(prev.stats ?? prev.error)}`);
  if (bookmarkletSeeded) ok(s.bookmarklets === 1, `EXPORT_PREVIEW counts the bookmarklet (${s.bookmarklets})`);

  const snap = await send({ type: 'SNAPSHOT_CREATE' });
  ok(snap.ok && snap.snapshot?.stats?.tabs >= 5, `Back up now (SNAPSHOT_CREATE): ${short(snap.snapshot?.stats ?? snap.error)}`);
  const got = snap.ok && snap.snapshot ? await send({ type: 'SNAPSHOT_GET', id: snap.snapshot.id }) : null;
  snapData = got?.data;
  ok(!!snapData, 'SNAPSHOT_GET returns the data');
  const list = await send({ type: 'SNAPSHOTS_LIST' });
  ok(list.ok && list.snapshots.some((x) => x.reason === 'manual'), 'SNAPSHOTS_LIST has the manual snapshot');

  const sched = await send({ type: 'SCHEDULE_SET', settings: { enabled: true, frequency: 'daily', keep: 5, includeBookmarks: true } });
  ok(sched.ok && sched.settings.enabled, 'SCHEDULE_SET');
  const alarms = await ext(() => browser.alarms.getAll());
  ok(alarms.length === 1, `alarm registered ${JSON.stringify(alarms.map((a) => a.periodInMinutes))}`);
});

// ---------- 5. EXPORT to a file ----------
let exported;
let exportPath;
await section('EXPORT', async () => {
  const ex = await send({ type: 'EXPORT', options: exportOptions, saveAs: false });
  ok(ex.ok, `EXPORT reply ${short(ex)}`);
  // Firefox writes <name>.part first and renames it: wait until the final file is complete.
  const file = await poll(() => {
    const names = readdirSync(dlDir);
    const f = names.find((n) => n.startsWith('tabs-export-') && n.endsWith('.json'));
    if (!f || names.some((n) => n.endsWith('.part'))) return null;
    try {
      JSON.parse(readFileSync(join(dlDir, f), 'utf8'));
      return f;
    } catch {
      return null;
    }
  }, { timeout: 10_000 });
  ok(!!file, `EXPORT downloaded ${readdirSync(dlDir)}`);
  if (!file) return;
  const path = join(dlDir, file);
  exported = JSON.parse(readFileSync(path, 'utf8'));
  exportPath = path;
  ok(exported.schemaVersion === '1.1' && exported.windows.length >= 1, `exported file is valid v1.1 (schemaVersion ${exported.schemaVersion})`);
  const allTabs = exported.windows.flatMap((w) => [...(w.ungroupedTabs ?? []), ...(w.groups ?? []).flatMap((g) => g.tabs)]);
  const urls = allTabs.map((t) => t.url);
  ok([0, 1, 2, 3, 4].every((i) => urls.includes(`${base}/p${i}.html`)), `export holds the five seeded tabs`);
  ok(!urls.some((u) => u.startsWith('moz-extension:')), 'excludeInternal drops moz-extension tabs');
  const seedWin = exported.windows.find((w) => [...(w.ungroupedTabs ?? []), ...(w.groups ?? []).flatMap((g) => g.tabs)].some((t) => t.url.endsWith('/p0.html')));
  ok(seedWin?.groups?.length === 1 && seedWin.groups[0].title === 'Smoke' && seedWin.groups[0].color === 'purple' && seedWin.groups[0].tabs.length === 2, `export group ${short(seedWin?.groups?.map((g) => ({ t: g.title, c: g.color, n: g.tabs.length })))}`);
  ok(seedWin?.ungroupedTabs?.some((t) => t.url.endsWith('/p1.html') && t.pinned === true), 'export pinned tab flagged');
  const nodes = [];
  (function walk(n) {
    if (!n) return;
    nodes.push(n);
    (n.children ?? []).forEach(walk);
  })({ children: exported.bookmarks });
  ok(nodes.some((n) => n.url === `${base}/bm.html`), 'export holds the bookmark');
  ok(nodes.some((n) => n.url === `${base}/nested.html`), 'export holds the nested bookmark');
  if (bookmarkletSeeded) ok(nodes.some((n) => n.url === 'javascript:void(document.title)'), 'bookmarklet exported');
  if (seed?.separator === true) {
    ok(nodes.some((n) => n.type === 'separator'), `separator exported (types: ${[...new Set(nodes.map((n) => n.type))]})`);
  }
});

// ---------- helpers for restore checks ----------
async function waitImportDone(timeout = 30_000) {
  let s;
  await poll(
    async () => {
      s = (await send({ type: 'GET_STATE' })).importState;
      return !['running', 'cancelling'].includes(s.status);
    },
    { timeout, interval: 200 },
  );
  return s;
}
const readTabs = () =>
  ext(async () => {
    const tabs = await browser.tabs.query({});
    const groups = await browser.tabGroups.query({});
    return {
      tabs: tabs
        .filter((t) => /\/p\d\.html/.test(t.url ?? '') || /\/lazy\.html/.test(t.url ?? ''))
        .map((t) => ({ url: t.url, u: t.url.split('/').pop(), id: t.id, w: t.windowId, i: t.index, g: t.groupId, pin: t.pinned, d: t.discarded, a: t.active, title: t.title })),
      groups: groups.map((g) => ({ id: g.id, w: g.windowId, title: g.title, color: g.color })),
    };
  });
async function closeRestoredWindows() {
  await ext(async () => {
    const tabs = await browser.tabs.query({});
    const wins = new Set(tabs.filter((t) => /\/p\d\.html/.test(t.url ?? '') || /\/lazy\.html/.test(t.url ?? '')).map((t) => t.windowId));
    for (const id of wins) await browser.windows.remove(id).catch(() => {});
  });
  await poll(async () => (await readTabs()).tabs.length === 0, { timeout: 8000 });
}

// ---------- 6. restore (discard mode, bookmarks merge) ----------
let mergeResult;
await section('restore discard', async () => {
  ok(await ext((id) => browser.windows.remove(id).then(() => true, () => false), seed.windowId), 'closed the seed window');
  await poll(async () => (await readTabs()).tabs.length === 0, { timeout: 8000 });
  ok(!!snapData, 'have snapshot data to restore');
  const start = await send({
    type: 'IMPORT_START',
    data: snapData,
    options: { importTabs: true, importBookmarks: true, bookmarkStrategy: 'merge', restoreMode: 'discard', skipOpenTabs: true },
  });
  ok(start.ok, 'IMPORT_START');
  const fin = await waitImportDone();
  mergeResult = fin;
  ok(fin.status === 'done', `import status ${fin.status} ${fin.error ?? ''}`);
  console.log('     result', JSON.stringify({ ...fin.result, failures: fin.result?.failures?.slice(0, 5) }));
  await sleep(800); // let discards / grouping settle
  const after = await readTabs();
  console.log('     tabs', JSON.stringify(after.tabs.map(({ url, id, title, ...rest }) => rest)));
  const sorted = [...after.tabs].sort((a, b) => a.i - b.i);
  ok(sorted.map((t) => t.u).join(',') === 'p1.html,p0.html,p2.html,p3.html,p4.html', `order restored: ${sorted.map((t) => t.u)}`);
  ok(new Set(sorted.map((t) => t.w)).size === 1, 'all tabs in a single restored window');
  const winTabs = await ext((w) => browser.tabs.query({ windowId: w }), sorted[0]?.w);
  ok(winTabs.length === 5, `restored window has exactly 5 tabs (default blank tab removed): ${winTabs.map((t) => t.url)}`);
  const by = (u) => after.tabs.find((t) => t.u === u);
  ok(by('p1.html')?.pin === true && by('p1.html')?.i === 0, 'pinned kept (and first)');
  const grp = after.groups.find((g) => g.title === 'Smoke');
  ok(grp?.color === 'purple', `group title+color restored ${JSON.stringify(after.groups)}`);
  ok(grp && by('p2.html')?.g === grp.id && by('p3.html')?.g === grp.id && by('p4.html')?.g !== grp.id && by('p0.html')?.g !== grp.id, 'group holds exactly p2,p3');
  ok(by('p0.html')?.a === true && by('p0.html')?.d === false, 'active tab (p0) is loaded, not discarded');
  ok(['p2.html', 'p3.html', 'p4.html'].every((u) => by(u)?.d === true), `non-active tabs discarded: ${after.tabs.map((t) => `${t.u}:${t.d}`)}`);
  ok(['p2.html', 'p3.html', 'p4.html'].every((u) => by(u)?.title === `/${u}` && by(u)?.url === `${base}/${u}`), `discarded tabs keep URL and title: ${short(['p2.html', 'p3.html', 'p4.html'].map((u) => [by(u)?.title, by(u)?.url]))}`);
  ok(fin.result?.tabs === 5 && fin.result?.tabsFailed === 0 && fin.result?.groups >= 1, `tab counters ${short({ t: fin.result?.tabs, f: fin.result?.tabsFailed, g: fin.result?.groups, w: fin.result?.windows })}`);
  ok(fin.result?.bookmarksSkipped >= 1 && fin.result?.bookmarks === 0 && fin.result?.bookmarksFailed === 0, `bookmark merge dedup (created ${fin.result?.bookmarks}, skipped ${fin.result?.bookmarksSkipped}, failed ${fin.result?.bookmarksFailed})`);
  const dupes = await ext(async () => {
    const found = await browser.bookmarks.search({ title: 'Smoke BM' });
    const nested = await browser.bookmarks.search({ title: 'Smoke Nested' });
    const seps = (await browser.bookmarks.getChildren('toolbar_____')).filter((c) => c.type === 'separator').length;
    return { bm: found.length, nested: nested.length, seps };
  });
  ok(dupes.bm === 1 && dupes.nested === 1 && dupes.seps <= 1, `no duplicated bookmarks/separators after merge ${JSON.stringify(dupes)}`);
});

// ---------- 7. lazy mode ----------
await section('restore lazy', async () => {
  await closeRestoredWindows();
  const start = await send({ type: 'IMPORT_START', data: snapData, options: { importTabs: true, importBookmarks: false, restoreMode: 'lazy' } });
  const fin = await waitImportDone();
  ok(start.ok && fin.status === 'done', `lazy import status ${fin.status} ${fin.error ?? ''}`);
  await sleep(1000);
  const st = await readTabs();
  const lazy = st.tabs.filter((t) => t.url.startsWith(`${EXT}/lazy.html`));
  console.log('     tabs', JSON.stringify(st.tabs.map(({ url, id, title, ...rest }) => rest)));
  ok(lazy.length >= 4, `lazy placeholders: ${lazy.length}`);
  ok(lazy.every((t) => new URL(t.url).searchParams.get('url')?.startsWith(base)), 'lazy URLs carry the real page in ?url=');
  ok(lazy.every((t) => t.url.startsWith(`${EXT}/lazy.html`)), `lazy pages stay unloaded while hidden (${lazy.map((t) => t.u)})`);
  const target = lazy.find((t) => !t.pin) ?? lazy[0];
  const want = new URL(target.url).searchParams.get('url');
  await ext((id) => browser.tabs.update(id, { active: true }), target.id);
  const nav = await poll(async () => (await ext((id) => browser.tabs.get(id), target.id)).url === want, { timeout: 8000 });
  ok(nav, `activating a lazy tab navigates to the real page (${want})`);
  const stillLazy = (await readTabs()).tabs.filter((t) => t.url.startsWith(`${EXT}/lazy.html`)).length;
  ok(stillLazy === lazy.length - 1, `other lazy tabs untouched (${stillLazy} left)`);
});

// ---------- 8. import from a file through the UI ----------
await section('UI file import', async () => {
  ok(!!exportPath, 'have an exported file to import');
  await closeRestoredWindows();
  const ui = await openExtPage('popup.html?view=tab#import');
  await poll(() => ui.$('#import-file'), { timeout: 8000 });
  const choose = await ui.$('#import-file');
  ok(!!choose, '#import-file present');
  if (!choose) return;
  // ElementHandle.uploadFile (BiDi input.setFiles) is refused in privileged extension pages: set the
  // input's files from a real File via DataTransfer and fire the change event instead.
  await ui.evaluate((content, name) => {
    const input = document.getElementById('import-file');
    const dt = new DataTransfer();
    dt.items.add(new File([content], name, { type: 'application/json' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, readFileSync(exportPath, 'utf8'), 'tabs-export.json');
  const summary = await poll(() => ui.$('#import-summary'), { timeout: 8000 });
  ok(!!summary, 'import summary appears after choosing a file');
  const txt = await ui.evaluate(() => document.querySelector('#import-summary')?.innerText ?? '');
  note(`summary: ${short(txt.replace(/\s+/g, ' '), 200)}`);
  if (process.env.SHOTS) await ui.screenshot({ path: join(process.env.SHOTS, 'ff-summary.png') }).catch(() => {});
  const btn = await poll(async () => {
    const b = await ui.$('#btn-import');
    return b && !(await b.evaluate((el) => el.disabled)) ? b : null;
  }, { timeout: 8000 });
  ok(!!btn, '#btn-import enabled');
  if (!btn) return;
  // A coordinate click is refused in privileged pages ("not clickable"); a DOM click drives the same React handler.
  await btn.evaluate((el) => { el.scrollIntoView(); el.click(); });
  await waitImportDone();
  const results = await poll(() => ui.evaluate(() => !!document.querySelector('#results-card')?.innerText.trim()), { timeout: 15_000 });
  ok(!!results, 'results card appears after Start restore');
  const rtxt = await ui.evaluate(() => document.querySelector('#results-card')?.innerText ?? '');
  note(`results: ${short(rtxt.replace(/\s+/g, ' '), 260)}`);
  const fin = (await send({ type: 'GET_STATE' })).importState;
  ok(fin.status === 'done' && fin.result?.tabs >= 5, `UI restore finished: ${short({ status: fin.status, tabs: fin.result?.tabs, failed: fin.result?.tabsFailed, bm: fin.result?.bookmarks, errors: fin.result?.errors })}`);
  const st = await readTabs();
  ok(['p0.html', 'p1.html', 'p2.html', 'p3.html', 'p4.html'].every((u) => st.tabs.some((t) => t.u === u)), `UI restore opened the tabs (${st.tabs.map((t) => t.u)})`);
  await ui.close().catch(() => {});
});

// ---------- 9. bookmark strategies ----------
await section('bookmark replace/folder', async () => {
  const run = async (strategy) => {
    const r = await send({
      type: 'IMPORT_START',
      data: snapData,
      options: { importTabs: false, importBookmarks: true, bookmarkStrategy: strategy, skipDuplicateBookmarks: strategy !== 'replace', importBookmarklets: true },
    });
    const fin = r.ok ? await waitImportDone() : { status: `start-failed ${short(r)}` };
    return fin;
  };
  // folder
  const f = await run('folder');
  ok(f.status === 'done' && f.result?.bookmarks > 0 && f.result?.bookmarksFailed === 0, `folder strategy ${short({ s: f.status, r: f.result && { b: f.result.bookmarks, f: f.result.bookmarksFailed, s: f.result.bookmarksSkipped }, failures: f.result?.failures?.slice(0, 3) })}`);
  const folder = await ext(async () => {
    const kids = await browser.bookmarks.getChildren('unfiled_____');
    const dir = kids.find((k) => !k.url && /^Imported /.test(k.title));
    return dir ? { title: dir.title, tree: (await browser.bookmarks.getSubTree(dir.id))[0] } : null;
  });
  ok(!!folder, `dated folder created under Other Bookmarks (unfiled_____): ${folder?.title}`);
  const flat = [];
  (function walk(n) {
    if (!n) return;
    flat.push(n);
    (n.children ?? []).forEach(walk);
  })(folder?.tree);
  ok(flat.some((n) => n.url === `${base}/bm.html`) && flat.some((n) => n.url === `${base}/nested.html`), 'folder holds the imported bookmarks');
  if (bookmarkletSeeded) ok(flat.some((n) => n.url?.startsWith('javascript:')), 'bookmarklet restored into the dated folder (Firefox accepts it)');
  else note('bookmarklet restore into folder not verified (Firefox refused to create one)');
  if (seed?.separator === true) ok(flat.some((n) => n.type === 'separator'), 'separator recreated in the dated folder');

  // replace
  await ext((b) => browser.bookmarks.create({ parentId: 'unfiled_____', title: 'Smoke Doomed Later', url: `${b}/doomed-later.html` }), base);
  const before = await send({ type: 'SNAPSHOTS_LIST' });
  const beforeN = before.snapshots.filter((s) => s.reason === 'pre-replace').length;
  const r = await run('replace');
  ok(r.status === 'done' && r.result?.bookmarksFailed === 0, `replace strategy ${short({ s: r.status, r: r.result && { b: r.result.bookmarks, f: r.result.bookmarksFailed, s: r.result.bookmarksSkipped }, failures: r.result?.failures?.slice(0, 3), error: r.error })}`);
  const after = await send({ type: 'SNAPSHOTS_LIST' });
  const pre = after.snapshots.filter((s) => s.reason === 'pre-replace');
  ok(pre.length === beforeN + 1, `a 'pre-replace' snapshot was created first (${beforeN} -> ${pre.length})`);
  const preData = pre[0] ? (await send({ type: 'SNAPSHOT_GET', id: pre[0].id })).data : null;
  ok(JSON.stringify(preData?.bookmarks ?? '').includes('Smoke Doomed'), 'pre-replace snapshot kept the bookmarks about to be removed');
  ok(JSON.stringify(preData?.bookmarks ?? '').includes('Smoke Doomed Later'), 'pre-replace snapshot holds a bookmark created after the backup');
  const live = await ext(async () => ({
    doomed: (await browser.bookmarks.search({ title: 'Smoke Doomed Later' })).length,
    bm: (await browser.bookmarks.search({ title: 'Smoke BM' })).filter((b) => b.parentId === 'toolbar_____').length,
    folders: (await browser.bookmarks.getChildren('unfiled_____')).filter((k) => /^Imported /.test(k.title)).length,
  }));
  ok(live.doomed === 0 && live.bm === 1 && live.folders === 0, `replace cleared old bookmarks and restored the backup ${JSON.stringify(live)}`);
});

// ---------- 10. diagnostics ----------
await section('diagnostics', async () => {
  const d = await send({ type: 'DIAGNOSTICS' });
  const logs = d.report?.logs ?? [];
  const errs = logs.filter((l) => l.level === 'ERROR');
  ok(d.ok && errs.length === 0, `no worker ERROR logs ${short(errs, 800)}`);
  const warns = logs.filter((l) => l.level === 'WARN');
  if (warns.length) note(`WARN logs: ${short(warns.map((w) => `${w.action}${w.error ? `: ${w.error.message}` : ''}`), 1200)}`);
  ok(/Firefox/.test(d.report?.userAgent ?? ''), `diagnostics userAgent ${d.report?.userAgent}`);
});

// ---------- 11. action popup size ----------
await section('popup size', async () => {
  // openPopup needs a user gesture in Firefox: give it a real (trusted) click on an injected button.
  await ext(() => {
    const b = document.createElement('button');
    b.id = '__tm_open_popup';
    b.textContent = 'open';
    b.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;width:80px;height:40px';
    b.onclick = () => {
      window.__tmPopup = 'pending';
      browser.action.openPopup().then(() => (window.__tmPopup = 'opened'), (e) => (window.__tmPopup = `error: ${e}`));
    };
    document.body.append(b);
  });
  await (await pg.$('#__tm_open_popup'))?.click();
  const outcome = await poll(() => ext(() => (window.__tmPopup !== 'pending' ? window.__tmPopup : null)), { timeout: 5000 });
  const popup = (await browser.pages()).find((p) => !knownPages.has(p) && p !== opener && /popup\.html$/.test(p.url()));
  if (popup) {
    const [w, h] = await popup.evaluate(() => [innerWidth, innerHeight]);
    ok(w >= 400 && h >= 560, `action popup size ${w}x${h}`);
  } else {
    note(`SKIPPED popup size: browser.action.openPopup() gave "${outcome}" and no popup page was exposed to BiDi (headless Firefox)`);
  }
});

// ---------- screenshot for debugging ----------
if (process.env.SHOTS) await pg.screenshot({ path: join(process.env.SHOTS, 'ff-popup.png') }).catch(() => {});

await cleanup();
console.log(failed ? `${failed} FAILED` : 'FIREFOX E2E PASSED');
process.exit(failed ? 1 : 0);
