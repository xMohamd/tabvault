// Real-browser checks for the backup-safety and convenience features (not part of `npm test`):
// scoped quick-save export, password-protected export + unlock in the Import UI,
// restore into the current window with group merging, automatic backup written as a file.
// Needs Chrome for Testing or Chromium (branded Chrome ignores --load-extension):
//   CHROME=/path/to/chrome pnpm test:e2e:features
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


const poll = async (fn, ms = 15000, step = 200) => {
    const end = Date.now() + ms;
    let v;
    while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
    return v;
};
const waitImport = async () => poll(async () => {
    const s = (await send({ type: 'GET_STATE' })).importState;
    return ['running', 'cancelling'].includes(s.status) ? null : s;
}, 30000, 250);
/** Types into a React-controlled input (native setter + input event). */
const typeInto = (selector, value) => evaluate(`
  const el = document.querySelector(${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;`);
const setFile = async (path) => {
    await cdp('DOM.enable', {}, sessionId);
    const { result: { root } } = await cdp('DOM.getDocument', {}, sessionId);
    const { result: { nodeId } } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: '#import-file' }, sessionId);
    await cdp('DOM.setFileInputFiles', { nodeId, files: [path] }, sessionId);
};

// --- 0. Keyboard shortcuts are all bound on a fresh install -------------------------------
// (A suggested key that clashes with a browser key, like Alt+Shift+B, is silently left unset.)
const commands = await evaluate(`return await chrome.commands.getAll();`);
for (const name of ['_execute_action', 'backup-now', 'save-window']) {
    const c = commands.find((x) => x.name === name);
    ok(!!c?.shortcut, `shortcut ${name} bound: ${c?.shortcut || 'NOT SET'}`);
}
ok(commands.every((c) => !/Alt\+Shift/.test(c.shortcut)), 'no Alt+Shift shortcuts (keyboard-layout toggle on many systems)');

// --- Seed: a window with 5 tabs, 2 of them in a group "Work" -------------------------------
const seed = await evaluate(`
  const w = await chrome.windows.create({ url: '${siteBase}/p0.html', focused: false });
  const ids = [];
  for (let i = 1; i <= 4; i++) ids.push((await chrome.tabs.create({ windowId: w.id, url: '${siteBase}/p' + i + '.html', active: false })).id);
  await new Promise((r) => setTimeout(r, 1200));
  const gid = await chrome.tabs.group({ tabIds: [ids[0], ids[1]], createProperties: { windowId: w.id } });
  await chrome.tabGroups.update(gid, { title: 'Work', color: 'green' });
  return { windowId: w.id, groupId: gid };`);
ok(seed.windowId && seed.groupId, 'seeded a window with a "Work" group');

// --- 1. Scoped export (what quick save uses) ------------------------------------------------
const scopedWindow = await send({ type: 'EXPORT_PREVIEW', options: { includeTabs: true, includeBookmarks: false, scope: { windowId: seed.windowId } } });
ok(scopedWindow.ok && scopedWindow.stats.windows === 1 && scopedWindow.stats.tabs === 5, `scope window: ${JSON.stringify(scopedWindow.stats)}`);
const scopedGroup = await send({ type: 'EXPORT_PREVIEW', options: { includeTabs: true, includeBookmarks: false, scope: { groupId: seed.groupId } } });
ok(scopedGroup.ok && scopedGroup.stats.tabs === 2 && scopedGroup.stats.groups === 1, `scope group: ${JSON.stringify(scopedGroup.stats)}`);

// --- 2. Password-protected export, then unlock in the Import UI -----------------------------
const PASSWORD = 'correct horse battery';
const enc = await send({ type: 'EXPORT', options: { includeTabs: true, includeBookmarks: false, password: PASSWORD }, saveAs: false });
ok(enc.ok && /\.encrypted\.json$/.test(enc.filename), `encrypted export reply ${JSON.stringify({ ok: enc.ok, filename: enc.filename })}`);
const encFile = await poll(() => readdirSync(dlDir).find((f) => f.endsWith('.encrypted.json')));
ok(!!encFile, `encrypted file downloaded: ${encFile}`);
let envelope = {};
if (encFile) envelope = JSON.parse(readFileSync(join(dlDir, encFile), 'utf8'));
ok(envelope.format === 'tabvault-encrypted' && envelope.kdf?.iterations === 600000 && envelope.cipher?.name === 'AES-GCM', 'file is an encrypted envelope (PBKDF2 600k, AES-GCM)');
ok(!JSON.stringify(envelope).includes('p0.html') && !JSON.stringify(envelope).includes(PASSWORD), 'no plaintext URLs or password in the file');
const diag = await send({ type: 'DIAGNOSTICS' });
ok(!JSON.stringify(diag.report).includes(PASSWORD), 'password not in diagnostics/logs');

if (encFile) {
    await setFile(join(dlDir, encFile));
    ok(await poll(() => evaluate(`return !!document.getElementById('import-password');`)), 'Import shows the unlock step');
    await typeInto('#import-password', 'wrong password');
    await evaluate(`document.getElementById('btn-unlock').click(); return true;`);
    const wrong = await poll(() => evaluate(`return /wrong password/i.test(document.body.innerText) ? document.body.innerText.match(/wrong password/i)[0] : null;`), 20000);
    ok(!!wrong, 'wrong password is rejected with "Wrong password"');
    await typeInto('#import-password', PASSWORD);
    await evaluate(`document.getElementById('btn-unlock').click(); return true;`);
    const summary = await poll(() => evaluate(`return document.getElementById('summary-format')?.textContent || null;`), 20000);
    ok(!!summary, `correct password unlocks the backup: ${summary}`);
    const stats = await evaluate(`return document.getElementById('summary-stats')?.innerText.replace(/\\n+/g, ' ');`);
    ok(/\b5\b/.test(stats ?? '') || /\b\d+ Tabs/.test(stats ?? ''), `unlocked summary: ${stats}`);
}

// --- 3. Restore into the current window, merging into the same-named group ------------------
const snap = await send({ type: 'SNAPSHOT_CREATE' });
const data = (await send({ type: 'SNAPSHOT_GET', id: snap.snapshot.id })).data;
// The extension tab's window is the last-focused normal window: give it its own "Work" group.
const target = await evaluate(`
  const me = await chrome.tabs.getCurrent();
  await chrome.windows.update(me.windowId, { focused: true });
  const extra = await chrome.tabs.create({ windowId: me.windowId, url: '${siteBase}/existing.html', active: false });
  const gid = await chrome.tabs.group({ tabIds: [extra.id], createProperties: { windowId: me.windowId } });
  await chrome.tabGroups.update(gid, { title: 'Work', color: 'blue' });
  const tabs = await chrome.tabs.query({ windowId: me.windowId });
  return { windowId: me.windowId, groupId: gid, tabsBefore: tabs.length, windowsBefore: (await chrome.windows.getAll()).length, activeBefore: tabs.find((t) => t.active)?.id };`);
const start = await send({ type: 'IMPORT_START', data, options: { importTabs: true, importBookmarks: false, target: 'current-window', mergeGroups: true, skipOpenTabs: false, restoreMode: 'discard' } });
ok(start.ok, 'IMPORT_START (current window, merge groups)');
const fin = await waitImport();
ok(fin.status === 'done', `restore status ${fin.status} ${fin.error ?? ''}`);
const after = await evaluate(`
  const tabs = await chrome.tabs.query({ windowId: ${target.windowId} });
  const groups = await chrome.tabGroups.query({ windowId: ${target.windowId} });
  return { tabs: tabs.length, windows: (await chrome.windows.getAll()).length, active: tabs.find((t) => t.active)?.id,
           work: groups.filter((g) => g.title === 'Work').map((g) => ({ id: g.id, color: g.color, n: tabs.filter((t) => t.groupId === g.id).length })) };`);
ok(after.windows === target.windowsBefore, `no new window created (${target.windowsBefore} -> ${after.windows})`);
ok(after.tabs === target.tabsBefore + 5, `5 tabs appended to the current window (${target.tabsBefore} -> ${after.tabs})`);
ok(after.work.length === 1 && after.work[0].id === target.groupId && after.work[0].n === 3, `merged into the existing "Work" group: ${JSON.stringify(after.work)}`);
ok(after.work[0]?.color === 'blue', 'existing group keeps its color');
ok(after.active === target.activeBefore, 'active tab in the current window unchanged');

// --- 4. Automatic backup also written as a file (real alarm) --------------------------------
const settings = await send({ type: 'SCHEDULE_SET', settings: { enabled: true, frequency: 'hourly', keep: 3, includeBookmarks: false, saveToFiles: true } });
ok(settings.ok && settings.settings.saveToFiles === true, 'SCHEDULE_SET saveToFiles');
// Change the state so the scheduled run isn't skipped as "unchanged", then fire the real alarm now
// (unpacked extensions may schedule alarms seconds ahead).
await evaluate(`await chrome.tabs.create({ url: '${siteBase}/changed.html', active: false }); await chrome.alarms.create('tabvault:auto-backup', { when: Date.now() + 1000, periodInMinutes: 60 }); return true;`);
const scheduled = await poll(async () => (await send({ type: 'SNAPSHOTS_LIST' })).snapshots.find((s) => s.reason === 'scheduled' && s.file), 20000, 500);
ok(!!scheduled, `scheduled snapshot with a file: ${scheduled?.file?.filename}`);
const backupFile = await poll(() => {
    try { return readdirSync(join(dlDir, 'TabVault')).find((f) => /^tabs-backup-.*\.json$/.test(f)); } catch { return null; }
}, 10000);
ok(!!backupFile, `file in Downloads/TabVault: ${backupFile}`);
if (backupFile) {
    const parsed = JSON.parse(readFileSync(join(dlDir, 'TabVault', backupFile), 'utf8'));
    ok(parsed.schemaVersion === '1.1' && parsed.windows.length >= 1, 'backup file is a valid v1.1 backup');
}

const errors = (await send({ type: 'DIAGNOSTICS' })).report.logs.filter((l) => l.level === 'ERROR');
ok(errors.length === 0, `no worker errors ${JSON.stringify(errors).slice(0, 300)}`);

ws.close(); proc.kill(); server.close();
console.log(failed ? `${failed} FAILED` : 'FEATURES PASSED');
process.exit(failed ? 1 : 0);
