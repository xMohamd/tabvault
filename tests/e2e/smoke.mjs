// Real-browser smoke test over the Chrome DevTools Protocol (not part of `npm test`).
// Needs Chrome for Testing or Chromium (branded Chrome ignores --load-extension):
//   CHROME=/path/to/chrome npm run test:e2e
// Set NO_SANDBOX=1 where unprivileged user namespaces are blocked (e.g. Ubuntu 24+ AppArmor).
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

// Run `pnpm build` first: this loads the built Chrome extension.
const extDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.output', 'chrome-mv3');
const CHROME = process.env.CHROME;
if (!CHROME) { console.error('Set CHROME to a Chrome for Testing / Chromium binary.'); process.exit(2); }
const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<title>${req.url}</title><h1>${req.url}</h1>`);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.on('listening', r));
const siteBase = `http://127.0.0.1:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'tm-prof-'));
const dlDir = mkdtempSync(join(tmpdir(), 'tm-dl-'));
const PORT = 9300 + Math.floor(Math.random() * 500);
import { mkdirSync } from 'node:fs';
mkdirSync(join(profile, 'Default'), { recursive: true });
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: dlDir, prompt_for_download: false } }));
const proc = spawn(CHROME, ['--headless=new', ...(process.env.NO_SANDBOX ? ['--no-sandbox'] : []), `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run', '--no-default-browser-check',
    // A real-sized virtual screen; the headless default (800x600) caps popup height.
    '--window-size=1280,900', '--screen-info={1920x1080}', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) failed++; };

let ver;
for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const waiters = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); } });
const cdp = (method, params = {}, sessionId) => new Promise((r) => { const id = ++seq; waiters.set(id, r); ws.send(JSON.stringify({ id, method, params, sessionId })); });


let extId;
for (let i = 0; i < 50 && !extId; i++) {
    const { result } = await cdp('Target.getTargets');
    const sw = result.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes('/background.js'));
    if (sw) extId = new URL(sw.url).host; else await sleep(200);
}
ok(!!extId, `extension loaded (${extId})`);
if (!extId) { proc.kill(); process.exit(1); }

const { result: { targetId } } = await cdp('Target.createTarget', { url: `chrome-extension://${extId}/popup.html?view=tab#import` });
const { result: { sessionId } } = await cdp('Target.attachToTarget', { targetId, flatten: true });
await sleep(1500);
const evaluate = async (expr) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
};
const send = (msg) => evaluate(`return await chrome.runtime.sendMessage(${JSON.stringify(msg)});`);

// Popup rendered and localized?
const ui = await evaluate(`return { title: document.title, tabs: [...document.querySelectorAll('[role=tab]')].map(t => t.textContent.trim()), badge: document.getElementById('browser-badge')?.textContent, errs: document.body.innerText.match(/__MSG|undefined/g) };`);
ok(ui.tabs.length === 3 && !ui.errs, `popup UI ${JSON.stringify(ui)}`);

// Seed a window with tabs + group + bookmarks.
const seed = await evaluate(`
  const w = await chrome.windows.create({ url: '${siteBase}/p0.html', focused: false });
  const ids = [];
  for (let i = 1; i <= 4; i++) ids.push((await chrome.tabs.create({ windowId: w.id, url: '${siteBase}/p' + i + '.html', active: false })).id);
  await new Promise(r => setTimeout(r, 1500));
  const gid = await chrome.tabs.group({ tabIds: [ids[1], ids[2]], createProperties: { windowId: w.id } });
  await chrome.tabGroups.update(gid, { title: 'Smoke', color: 'purple' });
  await chrome.tabs.update(ids[0], { pinned: true });
  const [root] = await chrome.bookmarks.getTree();
  const bar = root.children.find(c => c.folderType === 'bookmarks-bar') || root.children[0];
  await chrome.bookmarks.create({ parentId: bar.id, title: 'Smoke BM', url: '${siteBase}/bm.html' });
  await chrome.bookmarks.create({ parentId: bar.id, title: 'Smoke JS', url: 'javascript:void(document.title)' });
  return { windowId: w.id };`);
ok(seed.windowId, 'seeded source window');

const state = await send({ type: 'GET_STATE' });
ok(state.ok && state.browser.features.tabGroups, `GET_STATE ${state.browser?.name}`);

const snap = await send({ type: 'SNAPSHOT_CREATE' });
ok(snap.ok && snap.snapshot?.stats?.tabs >= 5, `Back up now (scheduler in real SW): ${JSON.stringify(snap.snapshot?.stats ?? snap.error)}`);
const got = snap.ok ? await send({ type: 'SNAPSHOT_GET', id: snap.snapshot.id }) : null;
const data = got?.data;
const sched = await send({ type: 'SCHEDULE_SET', settings: { enabled: true, frequency: 'daily', keep: 5, includeBookmarks: true } });
ok(sched.ok && sched.settings.enabled, 'SCHEDULE_SET');
const alarm = await evaluate(`return await chrome.alarms.getAll();`);
ok(alarm.length === 1, `alarm registered ${JSON.stringify(alarm.map(a => a.periodInMinutes))}`);

const ex = await send({ type: 'EXPORT', options: { includeTabs: true, includeBookmarks: true, filters: { excludeInternal: true } }, saveAs: false });
await sleep(1500);
const files = readdirSync(dlDir);
ok(ex.ok && files.some((f) => f.startsWith('tabs-export-')), `EXPORT downloaded ${files}`);
if (files[0]) {
    const parsed = JSON.parse(readFileSync(join(dlDir, files[0]), 'utf8'));
    ok(parsed.schemaVersion === '1.1' && parsed.windows.length >= 1, 'exported file is valid v1.1');
    ok(JSON.stringify(parsed.bookmarks).includes('javascript:void(document.title)'), 'bookmarklet exported');
}

// Close the seed window, then restore from the snapshot.
await evaluate(`await chrome.windows.remove(${seed.windowId}); return true;`);
const start = await send({ type: 'IMPORT_START', data, options: { importTabs: true, importBookmarks: true, bookmarkStrategy: 'merge', restoreMode: 'discard', skipOpenTabs: true } });
ok(start.ok, 'IMPORT_START');
let fin;
for (let i = 0; i < 100; i++) { await sleep(200); fin = (await send({ type: 'GET_STATE' })).importState; if (!['running', 'cancelling'].includes(fin.status)) break; }
ok(fin.status === 'done', `import status ${fin.status} ${fin.error ?? ''}`);
console.log('     result', JSON.stringify({ ...fin.result, failures: fin.result?.failures?.slice(0, 3) }));
const after = await evaluate(`
  const tabs = await chrome.tabs.query({});
  const groups = await chrome.tabGroups.query({});
  return { tabs: tabs.filter(t => (t.url || t.pendingUrl).includes('127.0.0.1')).map(t => ({ u: (t.url || t.pendingUrl).split('/').pop(), w: t.windowId, i: t.index, g: t.groupId, pin: t.pinned, d: t.discarded, a: t.active })), groups: groups.map(g => ({ title: g.title, color: g.color })) };`);
console.log('     tabs', JSON.stringify(after.tabs));
const order = after.tabs.sort((a, b) => a.i - b.i).map((t) => t.u).join(',');
ok(order === 'p1.html,p0.html,p2.html,p3.html,p4.html', `order restored: ${order}`);
ok(after.groups.some((g) => g.title === 'Smoke' && g.color === 'purple'), `group restored ${JSON.stringify(after.groups)}`);
ok(after.tabs.filter((t) => t.d).length >= 3, 'deferred tabs discarded and kept URL');
ok(after.tabs.find((t) => t.u === 'p1.html')?.pin === true, 'pinned kept');
ok(fin.result?.bookmarksSkipped >= 1 && fin.result?.bookmarks === 0, 'bookmark merge dedup in real browser');

// Lazy restore of the same data into a fresh state (skipOpenTabs false).
const start2 = await send({ type: 'IMPORT_START', data, options: { importTabs: true, importBookmarks: false, restoreMode: 'lazy' } });
for (let i = 0; i < 100; i++) { await sleep(200); fin = (await send({ type: 'GET_STATE' })).importState; if (!['running', 'cancelling'].includes(fin.status)) break; }
const lazy = await evaluate(`return (await chrome.tabs.query({})).filter(t => (t.url||t.pendingUrl).includes('/lazy.html')).length;`);
ok(start2.ok && fin.status === 'done' && lazy >= 3, `lazy mode tabs: ${lazy}`);

// Bookmarklets: restored into a dated folder by real Chrome, and skipped when the option is off.
{
    const run = async (importBookmarklets) => {
        const r = await send({ type: 'IMPORT_START', data, options: { importTabs: false, importBookmarks: true, bookmarkStrategy: 'folder', importBookmarklets } });
        let s;
        for (let i = 0; i < 100; i++) { await sleep(100); s = (await send({ type: 'GET_STATE' })).importState; if (!['running', 'cancelling'].includes(s.status)) break; }
        return r.ok ? s : { status: 'start-failed' };
    };
    const countJs = () => evaluate(`return (await chrome.bookmarks.search({ title: 'Smoke JS' })).filter(b => b.url?.startsWith('javascript:')).length;`);
    const before = await countJs();
    const on = await run(true);
    ok(on.status === 'done' && (await countJs()) === before + 1, `bookmarklet restored (failures: ${JSON.stringify(on.result?.failures ?? [])})`);
    const off = await run(false);
    ok(off.status === 'done' && (await countJs()) === before + 1 && off.result.bookmarksSkipped >= 1, 'bookmarklet skipped when the option is off');
}

// Regression: the real action popup must not collapse (viewport units used to lock it at 25x250).
{
    const sw = (await cdp('Target.getTargets')).result.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    const { result: { sessionId: swSession } } = await cdp('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    await cdp('Runtime.evaluate', { expression: 'chrome.action.openPopup().catch(() => {})', awaitPromise: true }, swSession);
    let popup;
    for (let i = 0; i < 30 && !popup; i++) {
        popup = (await cdp('Target.getTargets')).result.targetInfos.find((t) => t.url.endsWith('/popup.html'));
        if (!popup) await sleep(200);
    }
    if (popup) {
        const { result: { sessionId: ps } } = await cdp('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
        await sleep(1000);
        const r = await cdp('Runtime.evaluate', { expression: '[innerWidth, innerHeight]', returnByValue: true }, ps);
        const [w, h] = r.result.result.value;
        ok(w >= 400 && h >= 560, `action popup size ${w}x${h}`);
    } else {
        ok(false, 'action popup did not open');
    }
}

// Screenshot of the popup in tab view.
const shot = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
if (shot.result?.data) writeFileSync(join(dlDir, 'popup.png'), Buffer.from(shot.result.data, 'base64'));

const swLogs = await evaluate(`return (await chrome.runtime.sendMessage({ type: 'DIAGNOSTICS' })).report.logs.filter(l => l.level === 'ERROR');`);
ok(swLogs.length === 0, `no worker errors ${JSON.stringify(swLogs).slice(0, 400)}`);

ws.close(); proc.kill(); server.close();
console.log(failed ? `${failed} FAILED` : 'SMOKE PASSED');
process.exit(failed ? 1 : 0);
