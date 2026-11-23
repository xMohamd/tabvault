// Real-browser accessibility audit (axe-core) over the Chrome DevTools Protocol. Not part of `pnpm test`.
//   pnpm build && CHROME=/path/to/chrome-for-testing node tests/e2e/a11y.mjs
// Set NO_SANDBOX=1 where unprivileged user namespaces are blocked. VERBOSE=1 also prints axe "incomplete" results.
//
// Audits every popup state (real 420x580 action popup where possible, the full-tab view otherwise) in the light and
// dark theme, plus the lazy placeholder page under both prefers-color-scheme values. Then checks keyboard
// navigation (tab order, visible focus, Escape, arrow keys), prefers-reduced-motion and 200% zoom reflow.
// Exit code 1 on any serious/critical violation, any moderate one not in ALLOW, or any failed non-axe check.
// Test data is synthetic and generated below; nothing is read from the user's browser profile.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const extDir = resolve(root, '.output', 'chrome-mv3');
const axeSource = readFileSync(resolve(root, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
const CHROME = process.env.CHROME;
if (!CHROME) { console.error('Set CHROME to a Chrome for Testing / Chromium binary.'); process.exit(2); }

/**
 * Moderate violations that are accepted. Each entry needs a reason; `state` is optional (substring of the state name).
 * Serious and critical violations can never be allow-listed.
 */
const ALLOW = [
    // { id: 'rule-id', state: 'Import', reason: 'why this is acceptable' },
];

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const THEMES = ['light', 'dark'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- launch Chrome
const profile = mkdtempSync(join(tmpdir(), 'tm-a11y-prof-'));
const work = mkdtempSync(join(tmpdir(), 'tm-a11y-data-'));
mkdirSync(join(profile, 'Default'), { recursive: true });
const PORT = 9800 + Math.floor(Math.random() * 500);
const proc = spawn(CHROME, ['--headless=new', ...(process.env.NO_SANDBOX ? ['--no-sandbox'] : []), `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`, `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run',
    '--no-default-browser-check', '--window-size=1280,900', '--screen-info={1920x1080}', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { proc.kill(); } catch { /* already gone */ } try { rmSync(profile, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ } };
process.on('exit', cleanup);

let ver;
for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
if (!ver) { console.error('Chrome did not start'); process.exit(2); }
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
if (!extId) { console.error('Extension did not load (is .output/chrome-mv3 built, and is CHROME Chrome for Testing?)'); process.exit(2); }
const origin = `chrome-extension://${extId}`;

// ---------------------------------------------------------------- page driver
const KEYS = {
    Tab: { code: 'Tab', vk: 9 }, Enter: { code: 'Enter', vk: 13, text: '\r' }, Escape: { code: 'Escape', vk: 27 }, ' ': { code: 'Space', vk: 32, text: ' ' },
    ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowRight: { code: 'ArrowRight', vk: 39 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
    Home: { code: 'Home', vk: 36 }, End: { code: 'End', vk: 35 },
};

function driver(sessionId, targetId) {
    const p = {
        sessionId, targetId,
        async eval(expr) {
            const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }, sessionId);
            if (r.result?.exceptionDetails) throw new Error(`eval failed: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)} in ${expr.slice(0, 120)}`);
            return r.result?.result?.value;
        },
        async waitFor(expr, ms = 5000) {
            for (let t = 0; t < ms; t += 100) { if (await p.eval(`return !!(${expr});`).catch(() => false)) return true; await sleep(100); }
            throw new Error(`timeout waiting for: ${expr}`);
        },
        /** Toasts sit over the header and tab strip in the 580px popup; close them so they do not swallow pointer input. */
        async clearToasts() {
            await p.eval(`document.querySelectorAll('[data-sonner-toast] [data-close-button]').forEach((b) => b.click());`);
            await p.waitFor(`!document.querySelector('[data-sonner-toast]')`, 3000).catch(() => {});
        },
        async rect(sel) {
            const r = await p.eval(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };`);
            if (!r) throw new Error(`no element ${sel}`);
            return r;
        },
        async click(sel) {
            await p.clearToasts();
            const { x, y } = await p.rect(sel);
            await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
            await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
            await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
            await sleep(250);
        },
        async hover(sel) { await p.clearToasts(); const { x, y } = await p.rect(sel); await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId); await sleep(700); },
        async press(key, modifiers = 0) {
            const k = KEYS[key];
            await cdp('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.vk, text: k.text, modifiers }, sessionId);
            await sleep(40); // Held like a real keypress: Radix moves roving focus in a timeout and only auto-checks radios while the arrow is down.
            await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers }, sessionId);
            await sleep(120);
        },
        async type(sel, text) {
            await p.eval(`const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select?.();`);
            await cdp('Input.insertText', { text }, sessionId);
            await sleep(150);
        },
        async setFile(sel, path) {
            const { result } = await cdp('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})` }, sessionId);
            await cdp('DOM.setFileInputFiles', { files: [path], objectId: result.result.objectId }, sessionId);
            await sleep(600);
        },
        async send(msg) { return p.eval(`return await chrome.runtime.sendMessage(${JSON.stringify(msg)});`); },
        async reload(url) {
            if (url) await cdp('Page.navigate', { url }, sessionId); else await cdp('Page.reload', {}, sessionId);
            await sleep(400);
            await p.waitFor(`document.readyState === 'complete'`);
        },
        async inject() { await cdp('Runtime.evaluate', { expression: axeSource }, sessionId); },
        async axe(rulesOff = []) {
            await p.inject();
            return p.eval(`
              const r = await axe.run(document, { runOnly: { type: 'tag', values: ${JSON.stringify(TAGS)} }, rules: ${JSON.stringify(Object.fromEntries(rulesOff.map((r) => [r, { enabled: false }])))}, resultTypes: ['violations', 'incomplete'] });
              const slim = (list) => list.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map(n => ({ target: n.target.join(' >> '), html: n.html.slice(0, 140), summary: (n.failureSummary || '').split('\\n').slice(1, 3).join(' ').slice(0, 220) })) }));
              return { violations: slim(r.violations), incomplete: slim(r.incomplete) };`);
        },
        async setTheme(theme) {
            await p.eval(`localStorage.setItem('tabvault:theme', ${JSON.stringify(theme)});`);
        },
    };
    return p;
}

async function openTarget(url, background = false) {
    const { result: { targetId } } = await cdp('Target.createTarget', { url, background });
    const { result: { sessionId } } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Page.enable', {}, sessionId);
    const p = driver(sessionId, targetId);
    await p.waitFor(`document.readyState === 'complete'`);
    return p;
}

/** Opens the real action popup (420x580) from the service worker. Returns null when it does not appear. */
async function openActionPopup() {
    const targets = async () => (await cdp('Target.getTargets')).result.targetInfos;
    for (const t of (await targets()).filter((t) => t.url === `${origin}/popup.html`)) await cdp('Target.closeTarget', { targetId: t.targetId });
    const sw = (await targets()).find((t) => t.type === 'service_worker' && t.url.includes(extId));
    const { result: { sessionId: swSession } } = await cdp('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    await cdp('Runtime.evaluate', { expression: 'chrome.action.openPopup().catch(() => {})', awaitPromise: true }, swSession);
    let popup;
    for (let i = 0; i < 30 && !popup; i++) { popup = (await targets()).find((t) => t.url === `${origin}/popup.html`); if (!popup) await sleep(200); }
    if (!popup) return null;
    const { result: { sessionId } } = await cdp('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
    const p = driver(sessionId, popup.targetId);
    await p.waitFor(`document.querySelector('[role=tab]')`);
    await sleep(500);
    return p;
}

// ---------------------------------------------------------------- synthetic backups
const mkTab = (n, extra = {}) => ({ url: `https://example.com/page-${n}`, title: `Example page ${n}`, pinned: false, ...extra });
const tabs = (from, count) => Array.from({ length: count }, (_, i) => mkTab(from + i));
const smallBackup = {
    schemaVersion: '1.1', exportedAt: new Date().toISOString(),
    source: { browser: 'chrome', browserName: 'Chrome', extensionVersion: '1.0.0' },
    windows: [
        {
            title: 'Work', state: 'normal', width: 1200, height: 800,
            ungroupedTabs: [...tabs(1, 6), mkTab(7, { pinned: true }), { url: 'chrome://settings/', title: 'Settings', pinned: false }, { title: 'No URL tab', pinned: false }],
            groups: [
                { title: 'Research', color: 'blue', collapsed: false, tabs: tabs(10, 6) },
                { title: 'Reading list', color: 'orange', collapsed: false, tabs: tabs(20, 5) },
                { title: '', color: 'purple', collapsed: false, tabs: tabs(30, 3) },
            ],
        },
        { ungroupedTabs: [...tabs(40, 8), { url: 'javascript:void(0)', title: 'Script tab', pinned: false }], groups: [{ title: 'Misc', color: 'green', collapsed: false, tabs: tabs(50, 4) }] },
    ],
    bookmarks: [{
        title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
            { title: 'Example', url: 'https://example.com/' },
            { title: 'Docs', children: [{ title: 'Guide', url: 'https://example.com/guide' }, { title: 'API', url: 'https://example.com/api' }] },
            { title: 'Bookmarklet', url: 'javascript:void(document.title)' },
        ],
    }],
};
const bigBackup = { schemaVersion: '1.1', exportedAt: new Date().toISOString(), source: { browser: 'chrome', browserName: 'Chrome' }, windows: [{ ungroupedTabs: tabs(1, 210), groups: [] }], bookmarks: [] };
const smallPath = join(work, 'small-backup.json');
const bigPath = join(work, 'big-backup.json');
writeFileSync(smallPath, JSON.stringify(smallBackup));
writeFileSync(bigPath, JSON.stringify(bigBackup));

/** Builds a password-protected backup envelope (same format as src/lib/crypto.ts, with a low iteration count: the importer honours the file's). */
async function encryptEnvelope(json, password, iterations = 1000) {
    const b64 = (u8) => Buffer.from(u8).toString('base64');
    const salt = webcrypto.getRandomValues(new Uint8Array(16)); const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const data = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json)));
    return { format: 'tabvault-encrypted', version: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: b64(salt) }, cipher: { name: 'AES-GCM', iv: b64(iv) }, data: b64(data) };
}
const BACKUP_PASSWORD = 'correct horse';
const encryptedPath = join(work, 'small-backup.encrypted.json');
writeFileSync(encryptedPath, JSON.stringify(await encryptEnvelope(JSON.stringify(smallBackup), BACKUP_PASSWORD)));

// ---------------------------------------------------------------- results
const rows = [];       // { state, theme, id, impact, nodes, help, sample }
const incompletes = [];
const checks = [];     // non-axe checks { name, ok, detail }
let audited = 0;
/**
 * `exempt` switches rules off for ONE state, with the reason printed in the report. Use only for documented axe false
 * positives, never to hide a real problem.
 */
const exemptions = [];
async function audit(p, state, theme, exempt = {}) {
    for (const [rule, reason] of Object.entries(exempt)) exemptions.push({ state, rule, reason });
    const { violations, incomplete } = await p.axe(Object.keys(exempt));
    audited++;
    for (const v of violations) rows.push({ state, theme, id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, sample: v.nodes.slice(0, 2) });
    for (const v of incomplete) incompletes.push({ state, theme, id: v.id, nodes: v.nodes.length, sample: v.nodes[0] });
    console.log(`  audited ${state} [${theme}]: ${violations.length} violation(s)`);
}
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`); };

// ---------------------------------------------------------------- state scripts
const clickTab = (p, name) => p.click(`[role=tab][id$="trigger-${name}"]`);
const openSection = async (p, id) => { await p.click(`#${id} > button`); };

async function popupStates(theme) {
    console.log(`Action popup [${theme}]`);
    const p = await openActionPopup();
    if (!p) { check(`action popup opens [${theme}]`, false, 'chrome.action.openPopup did not open a popup'); return null; }
    const size = await p.eval('return [innerWidth, innerHeight, document.documentElement.dataset.theme];');
    check(`action popup is ${theme} and 420x580 [${theme}]`, size[2] === theme && size[0] >= 400 && size[1] >= 560, JSON.stringify(size));

    await audit(p, 'Popup: Export default', theme);
    await openSection(p, 'export-filters'); await openSection(p, 'export-options');
    await p.type('#ex-filter-domain', 'example.com');
    await audit(p, 'Popup: Export, Filters + Options expanded', theme);
    await p.click('#ex-tabs'); await p.click('#ex-bookmarks');
    await p.waitFor(`document.getElementById('export-empty-hint')`);
    await audit(p, 'Popup: Export, nothing selected', theme);
    await p.click('#ex-tabs'); // back on, so the password states below have a live export button
    await p.click('#ex-encrypt');
    await p.waitFor(`document.getElementById('ex-password')`);
    await audit(p, 'Popup: Export, password protection on (empty fields)', theme);
    await p.type('#ex-password', 'abc');
    await p.type('#ex-password-confirm', 'abd');
    await p.waitFor(`document.getElementById('ex-password-error') && document.getElementById('ex-password-confirm-error')`);
    await audit(p, 'Popup: Export, password too short + mismatch (errors)', theme);
    check(`Export: password errors are aria-invalid, described and announced [${theme}]`, await p.eval(`return [['ex-password', 'ex-password-error'], ['ex-password-confirm', 'ex-password-confirm-error']].every(([i, e]) => { const el = document.getElementById(i); return el.getAttribute('aria-invalid') === 'true' && (el.getAttribute('aria-describedby') || '').split(' ').includes(e) && document.getElementById(e)?.getAttribute('role') === 'alert'; });`));
    await p.type('#ex-password', BACKUP_PASSWORD);
    await p.type('#ex-password-confirm', BACKUP_PASSWORD);
    await p.waitFor(`!document.getElementById('ex-password-error') && !document.getElementById('ex-password-confirm-error')`);
    await audit(p, 'Popup: Export, password valid', theme);
    await p.click('#ex-encrypt'); // off again: the rest of the flow never exports

    await clickTab(p, 'import');
    // A finished restore from an earlier pass is still in the worker: the popup then opens on its results.
    await p.waitFor(`document.getElementById('import-empty') || document.getElementById('results-card')`);
    if (await p.eval(`return !!document.getElementById('results-card');`)) {
        await audit(p, 'Popup: Import results (previous restore)', theme);
        await p.click('#btn-results-another');
        await p.waitFor(`document.getElementById('import-empty')`);
    }
    await audit(p, 'Popup: Import empty', theme);

    await clickTab(p, 'backups');
    await p.waitFor(`document.getElementById('backups-panel') && !document.querySelector('[aria-busy=true]')`);
    if (await p.eval(`return !!document.getElementById('snapshots-empty');`)) await audit(p, 'Popup: Backups empty', theme);
    return p;
}

async function popupBackupStates(p, theme) {
    // Snapshots persist in the profile, so the second theme pass sees them too.
    for (let i = 0; i < 3 - (await p.send({ type: 'SNAPSHOTS_LIST' })).snapshots.length; i++) await p.send({ type: 'SNAPSHOT_CREATE' });
    await clickTab(p, 'export'); await clickTab(p, 'backups');
    await p.waitFor(`document.querySelectorAll('#snapshot-list > li').length >= 2`);
    await audit(p, 'Popup: Backups with snapshots', theme);
    await openSection(p, 'backups-auto');
    await audit(p, 'Popup: Backups, Automatic backups expanded', theme);
    await p.eval(`document.getElementById('bk-files').scrollIntoView({ block: 'center' });`);
    check(`Backups: "also save each backup as a file" switch is visible [${theme}]`, await p.eval(`const e = document.getElementById('bk-files'); const b = e?.getBoundingClientRect(); return !!b && b.width > 0 && b.height > 0 && e.getAttribute('role') === 'switch';`));
    await audit(p, 'Popup: Backups, "save as file" switch in Automatic backups', theme);
    await p.click('#bk-enabled');
    await p.type('#bk-keep', '0');
    await p.press('Tab');
    await p.waitFor(`document.getElementById('bk-settings-msg')`);
    await audit(p, 'Popup: Backups, keep input invalid', theme);
    await p.type('#bk-keep', '7'); await p.press('Tab');
    // Arm the delete button of the first snapshot (second click would delete it).
    await p.click('#snapshot-list > li:first-child button[aria-label*="elete"]');
    await audit(p, 'Popup: Backups, delete armed', theme);
    await p.press('Tab');
    await compareStates(p, theme);
    await searchStates(p, theme);
}

/** Search across backups: results, ticked results, a filter, nothing found; Escape returns to the list. */
async function searchStates(p, theme) {
    // "Search in": the menu, one backup unticked, back to all.
    check(`Search in: the button is named and shows the choice [${theme}]`, await p.eval(`const b = document.getElementById('search-scope'); return !!b && (b.getAttribute('aria-label') || '').includes(b.textContent.trim()) && b.textContent.trim().length > 0;`));
    await p.click('#search-scope');
    await p.waitFor(`document.querySelector('[role=menu]')`);
    check(`Search in: the menu fits the popup and lists All backups and each snapshot [${theme}]`, await p.eval(`const m = document.querySelector('[role=menu]'); const r = m.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight + 1 && m.querySelectorAll('[role=menuitemcheckbox]').length >= 3;`));
    await audit(p, 'Popup: Backups, "Search in" menu open', theme);
    await p.click('[role=menu] [data-scope-id]');
    await p.waitFor(`document.querySelector('[role=menu] [data-scope-id][aria-checked=false]')`);
    check(`Search in: the menu stays open while ticking [${theme}]`, await p.eval(`return !!document.querySelector('[role=menu]');`));
    await audit(p, 'Popup: Backups, "Search in" menu with one backup unticked', theme);
    await p.click('#scope-all');
    await p.waitFor(`document.getElementById('scope-all').getAttribute('aria-checked') === 'true'`);
    await p.press('Escape');
    await p.waitFor(`!document.querySelector('[role=menu]')`);
    // A row's "Search in this backup": limits the scope and focuses the search box.
    await p.click('#snapshot-list > li:nth-child(1) button[aria-label^="Search in"]');
    check(`Search in this backup: scope narrows to one backup and the search box is focused [${theme}]`, await p.eval(`return /^1 of \\d+ backups/.test(document.getElementById('search-scope').textContent.trim()) && document.activeElement?.id === 'backups-search';`));
    await p.click('#search-scope'); await p.waitFor(`document.querySelector('[role=menu]')`);
    await p.click('#scope-all'); await p.press('Escape');
    await p.waitFor(`!document.querySelector('[role=menu]')`);

    await p.type('#backups-search', 'cmp-');
    await p.waitFor(`document.querySelectorAll('#search-results [role=checkbox]').length >= 2`);
    check(`Search: input is a named search box [${theme}]`, await p.eval(`const i = document.getElementById('backups-search'); return i.type === 'search' && !!i.getAttribute('aria-label');`));
    check(`Search: rows have named checkboxes and the list is named [${theme}]`, await p.eval(`const l = document.getElementById('search-results'); return !!l.getAttribute('aria-label') && [...l.querySelectorAll('[role=checkbox]')].every((c) => (c.getAttribute('aria-label') || '').length > 0);`));
    await audit(p, 'Popup: Backups, search results', theme);
    await p.click('#search-results li:nth-child(1) [role=checkbox]');
    await p.click('#search-results li:nth-child(2) [role=checkbox]');
    await p.waitFor(`!document.getElementById('btn-restore-selected').disabled`);
    check(`Search: restore button is pinned and shows the count [${theme}]`, await p.eval(`const b = document.getElementById('btn-restore-selected'); const r = b.getBoundingClientRect(); return /\\b2\\b/.test(b.textContent) && r.bottom <= innerHeight + 1 && r.top >= 0;`));
    await audit(p, 'Popup: Backups, search results with two selected', theme);
    await p.hover('#search-results li:nth-child(1) button:not([role=checkbox])');
    await p.waitFor(`document.querySelector('[data-slot=tooltip-content]')`);
    await audit(p, 'Popup: Backups, search result sources tooltip', theme);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 500 }, p.sessionId);
    await p.click('#search-filter [data-state]:nth-child(2)');
    await audit(p, 'Popup: Backups, search results filtered to tabs', theme);
    await p.type('#backups-search', 'zzzz-no-such-page');
    await p.waitFor(`document.getElementById('search-empty')`);
    await audit(p, 'Popup: Backups, search without matches', theme);
    await p.eval(`document.getElementById('backups-search').focus();`);
    await p.press('Escape');
    await p.waitFor(`document.getElementById('snapshot-list') && !document.getElementById('search-empty')`);
    check(`Search: Escape clears the box and shows the snapshot list again [${theme}]`, await p.eval(`return document.getElementById('backups-search').value === '';`));
}

/** Two snapshots that differ in one tab each way, so the comparison has an added and a removed list. */
async function makeDifferingSnapshots(p) {
    const open = async (name) => { const t = await openTarget(`https://example.com/${name}`, true); await sleep(500); return t; };
    const a = await open(`cmp-a-${Date.now()}`);
    await p.send({ type: 'SNAPSHOT_CREATE' });
    await cdp('Target.closeTarget', { targetId: a.targetId });
    const b = await open(`cmp-b-${Date.now()}`);
    await p.send({ type: 'SNAPSHOT_CREATE' });
    await cdp('Target.closeTarget', { targetId: b.targetId });
}

async function compareStates(p, theme) {
    await makeDifferingSnapshots(p);
    await clickTab(p, 'export'); await clickTab(p, 'backups');
    await p.waitFor(`document.querySelectorAll('#snapshot-list > li').length >= 2`);
    await p.eval(`document.getElementById('snapshot-list').scrollIntoView();`);
    await p.click('#btn-compare');
    await p.waitFor(`document.querySelector('#snapshot-list [role=checkbox]')`);
    await audit(p, 'Popup: Backups, compare mode (nothing selected)', theme);
    await p.click('#snapshot-list > li:nth-child(1) [role=checkbox]');
    await p.click('#snapshot-list > li:nth-child(2) [role=checkbox]');
    await p.waitFor(`!document.getElementById('btn-compare-run').disabled`);
    await audit(p, 'Popup: Backups, compare mode (two selected)', theme);
    await p.click('#btn-compare-run');
    await p.waitFor(`document.getElementById('snapshot-compare')`);
    await audit(p, 'Popup: Snapshot comparison (collapsed)', theme);
    for (const id of ['cmp-tabs-added', 'cmp-tabs-removed']) {
        if (await p.eval(`return !!document.getElementById(${JSON.stringify(id)});`)) await openSection(p, id);
        else console.log(`  (comparison has no ${id} list)`);
    }
    await audit(p, 'Popup: Snapshot comparison (lists expanded)', theme);
    await p.click('#compare-back');
    await p.waitFor(`document.getElementById('snapshot-list')`);
}

async function popupHeaderStates(p, theme) {
    await p.hover('#btn-theme');
    await p.waitFor(`document.querySelector('[data-slot=tooltip-content]')`);
    await audit(p, 'Popup: Header theme tooltip', theme);
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 500 }, p.sessionId);
    await p.click('#btn-menu');
    await p.waitFor(`document.querySelector('[role=menu]')`);
    await audit(p, 'Popup: Header menu open', theme);
    // Keyboard shortcuts dialog (from the menu).
    await p.click('#btn-shortcuts');
    await p.waitFor(`document.querySelector('#shortcuts-list li')`);
    await audit(p, 'Popup: Keyboard shortcuts dialog', theme);
    await p.press('Escape');
    await p.waitFor(`!document.getElementById('shortcuts-dialog')`);
    // Toast: "Back up now" on the Backups tab.
    await clickTab(p, 'backups');
    await p.click('#btn-backup-now');
    await p.waitFor(`document.querySelector('[data-sonner-toast]')`);
    await sleep(500);
    await audit(p, 'Popup: Toast visible', theme);
}

async function tabViewStates(theme) {
    console.log(`Tab view [${theme}]`);
    const p = await openTarget(`${origin}/popup.html?view=tab#import`);
    await p.setTheme(theme);
    await p.reload();
    // A finished restore from an earlier pass is still in the worker: the page then opens on its results.
    await p.waitFor(`document.getElementById('import-empty') || document.getElementById('results-card')`);
    if (await p.eval(`return !!document.getElementById('results-card');`)) {
        await p.click('#btn-results-another');
        await p.waitFor(`document.getElementById('import-empty')`);
    }
    const t = await p.eval('return document.documentElement.dataset.theme;');
    if (t !== theme) throw new Error(`theme not applied: ${t}`);
    await audit(p, 'Tab: Import empty', theme);

    // Encrypted backup: unlock step, wrong password, unlocked review.
    await p.setFile('#import-file', encryptedPath);
    await p.waitFor(`document.getElementById('btn-unlock')`);
    await audit(p, 'Tab: Import, encrypted backup unlock step', theme);
    await p.type('#import-password', 'not the password');
    await p.click('#btn-unlock');
    await p.waitFor(`document.getElementById('import-password-error')`);
    await audit(p, 'Tab: Import, unlock wrong password', theme);
    await p.type('#import-password', BACKUP_PASSWORD);
    await p.click('#btn-unlock');
    await p.waitFor(`document.getElementById('import-summary') && document.getElementById('btn-import')`);
    await audit(p, 'Tab: Import review (unlocked backup)', theme);

    // Tab options: "Open in" radio group on "Current window", then restore the default.
    await openSection(p, 'tab-options');
    await p.click('#im-target-current-window');
    await p.waitFor(`document.getElementById('im-restore-layout').disabled`);
    await audit(p, 'Tab: Import review, tab options (open in current window)', theme);
    await p.click('#im-target-new-windows');

    // Search in the loaded file: results with checkboxes, ticked results, no matches, Escape back to the tree.
    await p.type('#preview-search', 'example');
    await p.waitFor(`document.getElementById('preview-results') && document.getElementById('btn-preview-select-all')`);
    await p.eval(`document.getElementById('import-search').scrollIntoView();`);
    check(`Import search: rows have named checkboxes and the list is named [${theme}]`, await p.eval(`const l = document.getElementById('preview-results'); return !!l.getAttribute('aria-label') && [...l.querySelectorAll('[role=checkbox]')].length > 5 && [...l.querySelectorAll('[role=checkbox]')].every((c) => (c.getAttribute('aria-label') || '').length > 0);`));
    check(`Import search: restore button is disabled and says what to do while nothing is ticked [${theme}]`, await p.eval(`const b = document.getElementById('btn-import'); return b.disabled && /select results/i.test(b.textContent);`));
    await audit(p, 'Tab: Import review, search results (nothing ticked)', theme);
    await p.click('#preview-results li:nth-child(1) [role=checkbox]');
    await p.click('#preview-results li:nth-child(2) [role=checkbox]');
    await p.waitFor(`/\\b2\\b/.test(document.getElementById('btn-import').textContent) && !document.getElementById('btn-import').disabled`);
    await audit(p, 'Tab: Import review, search results with two selected', theme);
    await p.click('#preview-filter [data-state]:nth-child(3)');
    await audit(p, 'Tab: Import review, search results filtered to bookmarks', theme);
    await p.type('#preview-search', 'zzz-no-such-tab');
    await p.waitFor(`document.getElementById('preview-empty')`);
    await audit(p, 'Tab: Import review, search with no matches', theme);
    await p.eval(`document.getElementById('preview-search').focus();`);
    await p.press('Escape');
    await p.waitFor(`document.getElementById('preview-tree') && !document.getElementById('preview-results')`);
    check(`Import search: Escape clears the box, brings the tree back and drops the ticks [${theme}]`, await p.eval(`return document.getElementById('preview-search').value === '' && !/selected/i.test(document.getElementById('btn-import').textContent);`));

    // Review with more than 200 tabs.
    await p.setFile('#import-file', bigPath);
    await p.waitFor(`document.getElementById('many-tabs-notice')`);
    await audit(p, 'Tab: Import review, >200 tabs notice', theme);

    await p.setFile('#import-file', smallPath);
    await p.waitFor(`document.getElementById('summary-warnings') && !document.getElementById('many-tabs-notice')`);
    await audit(p, 'Tab: Import review (summary, warnings, preview)', theme);

    // Tri-state: untick one group; then expand both option sections.
    await p.click('#pv-w0-g0');
    await p.waitFor(`document.getElementById('pv-w0').getAttribute('data-state') === 'indeterminate'`);
    await openSection(p, 'tab-options'); await openSection(p, 'bookmark-options');
    await p.eval(`document.getElementById('btn-import').scrollIntoView();`);
    await audit(p, 'Tab: Import review, partial selection + options expanded', theme);

    // Open listbox (Radix Select).
    await p.click('#im-restore-mode');
    await p.waitFor(`document.querySelector('[role=listbox]')`);
    // Radix Select is modal: it marks the rest of the page aria-hidden while the listbox is open and traps focus in the
    // listbox (checked in keyboardChecks). axe only exempts role=dialog from these two rules, so they are false positives here.
    await audit(p, 'Tab: Import review, loading-mode listbox open', theme, {
        'aria-hidden-focus': 'Radix Select hides the page behind the open listbox and traps focus inside it (see the keyboard check "Select traps Tab")',
        'page-has-heading-one': 'the page <h1> is aria-hidden by the same modal Select while the listbox is open',
    });
    await p.press('Escape');
    await p.waitFor(`!document.querySelector('[role=listbox]')`);

    // Replace confirmation.
    await p.click('#im-bm-replace');
    await p.click('#btn-import');
    await p.waitFor(`document.getElementById('replace-confirm')`);
    await audit(p, 'Tab: Replace confirmation dialog', theme);
    await p.press('Escape');
    await p.waitFor(`!document.getElementById('replace-confirm')`);
    await p.click('#im-bm-merge');
    await p.click('#pv-w0-g0'); // re-tick

    // Real restore: running, then results with failures.
    await p.click('#btn-import');
    await p.waitFor(`document.getElementById('import-progress') || document.getElementById('results-card')`, 15000);
    if (await p.eval(`return !!document.getElementById('import-progress');`)) await audit(p, 'Tab: Import running', theme);
    else console.log('  (restore finished before the running view could be audited; progress view is audited via the strip below)');
    await p.waitFor(`document.getElementById('results-card')`, 90000);
    await audit(p, 'Tab: Import results', theme);
    if (await p.eval(`return !!document.getElementById('results-failures-summary');`)) {
        await p.click('#results-failures-summary');
        await p.waitFor(`document.getElementById('results-failures-list')`);
        await audit(p, 'Tab: Import results, failures expanded', theme);
    } else console.log('  (no failures in results; failures list not audited)');
    // Close what the restore opened so later passes start clean.
    await p.eval(`const ws = await chrome.windows.getAll(); const keep = (await chrome.windows.getLastFocused()).id; for (const w of ws) { if (w.id !== keep) { try { await chrome.windows.remove(w.id); } catch {} } } return 1;`);
    return p;
}

async function lazyStates(theme) {
    console.log(`Lazy page [${theme}]`);
    // The page opens its target as soon as the tab is visible, and whether a background tab counts as
    // visible differs between machines. So the target answers "204 No Content": browsers ignore such a
    // navigation and the placeholder stays, whatever the visibility. (Holding the request unanswered
    // instead blocks every later command to the tab.)
    const p = await openTarget('about:blank', true);
    const answer204 = (e) => {
        const m = JSON.parse(e.data);
        if (m.method === 'Fetch.requestPaused' && m.sessionId === p.sessionId) {
            void cdp('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 204 }, p.sessionId);
        }
    };
    ws.addEventListener('message', answer204);
    await cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://example.com/*' }] }, p.sessionId);
    await cdp('Page.navigate', { url: `${origin}/lazy.html?url=${encodeURIComponent('https://example.com/')}&title=Example` }, p.sessionId);
    await p.waitFor(`location.pathname === '/lazy.html' && document.readyState === 'complete'`);
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, p.sessionId);
    await sleep(300);
    const where = await p.eval(`return location.pathname;`);
    check(`placeholder page itself is audited [${theme}]`, where === '/lazy.html', where);
    await audit(p, 'Lazy page', theme);
    ws.removeEventListener('message', answer204);
    await cdp('Target.closeTarget', { targetId: p.targetId });
}

// ---------------------------------------------------------------- keyboard / motion / reflow checks
/** Chrome starts Tab from the last click/focus, not from blur(): click the page title to start from the top. */
const focusFromTop = async (p) => { await p.eval(`document.activeElement?.blur?.(); window.scrollTo(0, 0);`); await p.click('h1'); };
/** Opens the Import tab on its empty state, dismissing the results of an earlier restore kept by the worker. */
async function gotoImportEmpty(p) {
    await clickTab(p, 'import');
    await p.waitFor(`document.getElementById('import-empty') || document.getElementById('results-card')`);
    if (await p.eval(`return !!document.getElementById('results-card');`)) {
        await p.click('#btn-results-another');
        await p.waitFor(`document.getElementById('import-empty')`);
    }
}
const describeJs = `(el) => (el.getAttribute('aria-label') || el.id || el.textContent.trim().slice(0, 30) || el.tagName).slice(0, 40) + ' <' + el.tagName.toLowerCase() + (el.getAttribute('role') ? ' role=' + el.getAttribute('role') : '') + '> #' + [...document.querySelectorAll('*')].indexOf(el)`;

/** Tabs through the page; reports unreachable controls, traps and elements with no visible focus indicator. */
async function tabOrderCheck(p, label) {
    await focusFromTop(p);
    const expected = await p.eval(`
      const desc = ${describeJs};
      const visible = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('[hidden],[inert]'); };
      return [...document.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex],[role=tab],[role=switch],[role=checkbox],[role=radio]')]
        .filter(e => e.tabIndex >= 0 && !e.disabled && visible(e) && !e.closest('[aria-hidden=true]') && !['tablist', 'radiogroup'].includes(e.getAttribute('role'))).map(desc);`);
    const reached = [], noRing = [];
    let trap = null;
    for (let i = 0; i < 120; i++) {
        await p.press('Tab');
        await sleep(60);
        const info = await p.eval(`
          const el = document.activeElement; if (!el || el === document.body) return { body: true };
          const cs = getComputedStyle(el);
          const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none';
          const r = el.getBoundingClientRect();
          return { d: (${describeJs})(el), ring, onScreen: r.bottom > 0 && r.top < innerHeight, focusVisible: el.matches(':focus-visible') };`);
        if (info.body) break;
        if (reached.includes(info.d) && reached[reached.length - 1] === info.d) { trap = info.d; break; }
        if (reached.includes(info.d)) break; // wrapped around
        reached.push(info.d);
        if (!info.ring || !info.focusVisible) noRing.push(info.d);
    }
    const missing = expected.filter((e) => !reached.includes(e));
    check(`${label}: every tabbable control reachable by Tab (${reached.length})`, missing.length === 0 && !trap, missing.length ? `missed ${missing.join('; ')} (order seen: ${reached.join(' > ')})` : trap ? `trap on ${trap}` : '');
    check(`${label}: visible focus indicator on every control`, noRing.length === 0, noRing.join('; '));
}

async function keyboardChecks() {
    console.log('Keyboard');
    const p = await openTarget(`${origin}/popup.html?view=tab#export`);
    await p.setTheme('light'); await p.reload();
    await p.waitFor(`document.getElementById('export-panel')`);
    await tabOrderCheck(p, 'Export');
    await openSection(p, 'export-filters'); await openSection(p, 'export-options');
    await tabOrderCheck(p, 'Export (sections expanded)');

    // Arrow keys on the main tab list (roving tabindex), Home/End.
    await p.eval(`document.querySelector('[role=tab][aria-selected=true]').focus();`);
    await p.press('ArrowRight');
    check('ArrowRight moves focus along the main tabs', await p.eval(`return document.activeElement.getAttribute('role') === 'tab' && document.activeElement.textContent.trim().length > 0 && document.activeElement !== document.querySelector('[role=tab]');`));
    await p.press('Enter');
    check('Enter/Space activates a focused tab', await p.eval(`return document.activeElement.getAttribute('aria-selected') === 'true';`));

    // Shift+Tab from the selected tab goes back to the header (no trap, no hidden stop on the tab list).
    await p.eval(`document.querySelector('[role=tab][aria-selected=true]').focus();`);
    await p.press('Tab', 8);
    check('Shift+Tab leaves the tab strip for the header', await p.eval(`return document.activeElement?.id === 'btn-menu';`), await p.eval(`return document.activeElement?.id;`));

    await gotoImportEmpty(p);
    await p.setFile('#import-file', smallPath);
    await p.waitFor(`document.getElementById('btn-import')`);
    await openSection(p, 'tab-options'); await openSection(p, 'bookmark-options');
    await tabOrderCheck(p, 'Import review');

    // Radio group arrows.
    await p.eval(`document.getElementById('im-bm-merge').focus();`);
    await p.press('ArrowDown');
    await sleep(150);
    check('Arrow keys move through bookmark radio group', await p.eval(`return document.getElementById('im-bm-folder').getAttribute('aria-checked') === 'true';`),
        await p.eval(`return 'checked=' + [...document.querySelectorAll('#bm-controls [role=radio]')].filter((r) => r.getAttribute('aria-checked') === 'true').map((r) => r.id) + ' focus=' + document.activeElement?.id;`));
    await p.press('ArrowUp');

    // Select (listbox) keyboard.
    await p.eval(`document.getElementById('im-restore-mode').focus();`);
    await p.press('Enter');
    const listOpen = await p.eval(`return !!document.querySelector('[role=listbox]');`);
    check('Select opens with Enter', listOpen);
    for (let i = 0; i < 3; i++) await p.press('Tab');
    check('Select traps Tab inside the open listbox', await p.eval(`const l = document.querySelector('[role=listbox]'); return !!l && l.contains(document.activeElement);`));
    await p.press('ArrowDown'); await p.press('Enter');
    await sleep(200);
    check('Select picks an option with arrows + Enter and closes', await p.eval(`return !document.querySelector('[role=listbox]');`));

    // Dialog: focus enters on Cancel, stays trapped, Escape closes and focus returns.
    await p.click('#im-bm-replace');
    await p.eval(`document.getElementById('btn-import').focus();`);
    await p.press('Enter');
    await p.waitFor(`document.getElementById('replace-confirm')`);
    check('Dialog focuses the safe (Cancel) button', await p.eval(`return document.activeElement?.id === 'btn-replace-no';`));
    const seen = new Set();
    for (let i = 0; i < 4; i++) { await p.press('Tab'); seen.add(await p.eval(`return !!document.getElementById('replace-confirm')?.contains(document.activeElement);`)); }
    check('Dialog traps Tab inside', seen.size === 1 && seen.has(true));
    await p.press('Escape');
    await p.waitFor(`!document.getElementById('replace-confirm')`);
    check('Escape closes the dialog and focus returns to the trigger', await p.eval(`return document.activeElement?.id === 'btn-import';`));
    await p.click('#im-bm-merge');

    // Menu: opens with Enter, arrows move, Escape closes and returns focus.
    await p.eval(`document.getElementById('btn-menu').focus();`);
    await p.press('Enter');
    await p.waitFor(`document.querySelector('[role=menu]')`);
    check('Menu focuses an item on open', await p.eval(`return document.activeElement?.getAttribute('role') === 'menuitem';`));
    await p.press('ArrowDown');
    await p.press('Escape');
    await sleep(200);
    check('Escape closes the menu and focus returns to its button', await p.eval(`return !document.querySelector('[role=menu]') && document.activeElement?.id === 'btn-menu';`));

    // Encrypted backup: autofocus, Enter submits (wrong, then right password).
    await clickTab(p, 'import');
    await p.setFile('#import-file', encryptedPath);
    await p.waitFor(`document.getElementById('import-password')`);
    check('Unlock: the password field is focused on arrival', await p.eval(`return document.activeElement?.id === 'import-password';`), await p.eval(`return document.activeElement?.id || document.activeElement?.tagName;`));
    await tabOrderCheck(p, 'Unlock');
    await p.type('#import-password', 'wrong password');
    await p.press('Enter');
    await p.waitFor(`document.getElementById('import-password-error')`);
    await sleep(300);
    check('Unlock: Enter in the password field submits (wrong password shows an error)', true);
    check('Unlock: focus returns to the password field after a failed attempt', await p.eval(`return document.activeElement?.id === 'import-password';`), await p.eval(`return document.activeElement?.id || document.activeElement?.tagName;`));
    check('Unlock: the error is announced and tied to the field', await p.eval(`const i = document.getElementById('import-password'); const e = document.getElementById('import-password-error'); return e?.getAttribute('role') === 'alert' && i.getAttribute('aria-invalid') === 'true' && (i.getAttribute('aria-describedby') || '').split(' ').includes('import-password-error');`));
    await p.type('#import-password', BACKUP_PASSWORD);
    await p.press('Enter');
    await p.waitFor(`document.getElementById('import-summary') && document.getElementById('btn-import')`);
    check('Unlock: Enter with the right password opens the review', true);

    // Search in the file: input -> results -> buttons, all by keyboard.
    await p.type('#preview-search', 'page-1');
    await p.waitFor(`document.getElementById('preview-results')`);
    await tabOrderCheck(p, 'Import review (search results)');
    await p.eval(`document.getElementById('preview-search').focus();`);
    const searchOrder = [];
    for (let i = 0; i < 8; i++) { await p.press('Tab'); searchOrder.push(await p.eval(`return document.activeElement?.id || document.activeElement?.getAttribute('aria-label') || document.activeElement?.tagName;`)); }
    check('Search: Tab from the input reaches the filter, Select all and then the result checkboxes (Clear selection is disabled until something is ticked)', searchOrder[0] === 'BUTTON' && searchOrder[1] === 'btn-preview-select-all' && searchOrder.slice(2).every((x) => /^Example page/.test(x)) && !searchOrder.includes('btn-preview-clear'), searchOrder.join(' > '));
    await p.eval(`document.getElementById('btn-preview-select-all').focus();`);
    await p.press('Enter');
    check('Search: Select all works with Enter and the button shows the count', await p.eval(`const b = document.getElementById('btn-import'); return /selected/i.test(b.textContent) && !b.disabled;`), await p.eval(`return document.getElementById('btn-import').textContent;`));
    await p.eval(`document.querySelector('#preview-results [role=checkbox]').focus();`);
    await p.press(' ');
    check('Search: Space unticks a result', await p.eval(`return document.querySelector('#preview-results [role=checkbox]').getAttribute('aria-checked') === 'false';`));
    await p.eval(`document.getElementById('btn-preview-clear').focus();`);
    await p.press(' ');
    check('Search: Clear selection works with Space', await p.eval(`return document.getElementById('btn-import').disabled && /select results/i.test(document.getElementById('btn-import').textContent);`));
    await p.eval(`document.getElementById('preview-search').focus();`);
    await p.press('Escape');
    check('Search: Escape in the box clears the search', await p.eval(`return document.getElementById('preview-search').value === '' && !!document.getElementById('preview-tree');`));
    await p.eval(`document.getElementById('btn-menu').focus();`);

    // "Search in" menu (Backups): opens with Enter, items are checkboxes toggled with Space, the menu stays open, Escape returns focus.
    await clickTab(p, 'backups');
    await p.waitFor(`document.getElementById('backups-panel')`);
    for (let i = 0; i < 2 - (await p.send({ type: 'SNAPSHOTS_LIST' })).snapshots.length; i++) await p.send({ type: 'SNAPSHOT_CREATE' });
    await clickTab(p, 'export'); await clickTab(p, 'backups');
    await p.waitFor(`document.getElementById('search-scope')`);
    await tabOrderCheck(p, 'Backups (search scope)');
    await p.eval(`document.getElementById('search-scope').focus();`);
    await p.press('Enter');
    await p.waitFor(`document.querySelector('[role=menu]')`);
    check('Search in: the menu focuses an item on open', await p.eval(`return document.activeElement?.getAttribute('role') === 'menuitemcheckbox';`));
    await p.press('ArrowDown');
    await p.press('ArrowDown');
    const scopeItemBefore = await p.eval(`return document.activeElement?.getAttribute('aria-checked');`);
    await p.press(' ');
    check('Search in: Space toggles the focused backup and keeps the menu open', await p.eval(`return !!document.querySelector('[role=menu]') && document.activeElement?.getAttribute('aria-checked') !== ${JSON.stringify(scopeItemBefore)};`));
    check('Search in: the button reports the partial choice', /\d+ of \d+ backups/.test(await p.eval(`return document.getElementById('search-scope').textContent;`)));
    await p.press('Escape');
    await sleep(200);
    check('Search in: Escape closes the menu and focus returns to its button', await p.eval(`return !document.querySelector('[role=menu]') && document.activeElement?.id === 'search-scope';`));
    await p.click('#search-scope'); await p.waitFor(`document.querySelector('[role=menu]')`);
    await p.click('#scope-all');
    await p.press('Escape');

    // Compare mode checkboxes (Backups): reachable by Tab, toggled with Space.
    await clickTab(p, 'backups');
    await p.waitFor(`document.getElementById('backups-panel')`);
    for (let i = 0; i < 2 - (await p.send({ type: 'SNAPSHOTS_LIST' })).snapshots.length; i++) await p.send({ type: 'SNAPSHOT_CREATE' });
    await clickTab(p, 'export'); await clickTab(p, 'backups');
    await p.waitFor(`document.querySelectorAll('#snapshot-list > li').length >= 2`);
    await p.click('#btn-compare');
    await p.waitFor(`document.querySelector('#snapshot-list [role=checkbox]')`);
    await tabOrderCheck(p, 'Backups (compare mode)');
    await p.eval(`document.querySelector('#snapshot-list > li:nth-child(1) [role=checkbox]').focus();`);
    await p.press(' ');
    check('Compare: Space ticks a snapshot checkbox', await p.eval(`return document.querySelector('#snapshot-list > li:nth-child(1) [role=checkbox]').getAttribute('aria-checked') === 'true';`));
    await p.eval(`document.querySelector('#snapshot-list > li:nth-child(2) [role=checkbox]').focus();`);
    await p.press(' ');
    check('Compare: the second checkbox ticks too and enables Compare', await p.eval(`return document.querySelector('#snapshot-list > li:nth-child(2) [role=checkbox]').getAttribute('aria-checked') === 'true' && !document.getElementById('btn-compare-run').disabled;`));
    await p.press(' ');
    check('Compare: Space unticks again', await p.eval(`return document.querySelector('#snapshot-list > li:nth-child(2) [role=checkbox]').getAttribute('aria-checked') === 'false';`));
    await p.click('#btn-compare-cancel');

    // Toggle group arrows (Backups).
    await p.waitFor(`document.getElementById('backups-panel')`);
    await openSection(p, 'backups-auto');
    await tabOrderCheck(p, 'Backups');
    await p.eval(`document.querySelector('#bk-frequency [data-state=on]').focus();`);
    const before = await p.eval(`return document.querySelector('#bk-frequency [data-state=on]').textContent;`);
    await p.press('ArrowRight');
    check('ArrowRight moves focus within the frequency toggle group', await p.eval(`return document.activeElement.closest('#bk-frequency') !== null && document.activeElement.textContent !== ${JSON.stringify(before)};`));
    await cdp('Target.closeTarget', { targetId: p.targetId });
}

async function motionCheck() {
    console.log('Reduced motion');
    const slowAnimations = (p) => p.eval(`
      return document.getAnimations().map((a) => { const t = a.effect.getComputedTiming(); return { n: a.animationName || a.transitionProperty || '?', d: t.duration, i: t.iterations }; })
        .filter((a) => a.d > 50 || a.i === Infinity).map((a) => a.n + ':' + a.d + 'x' + a.i);`);
    // The same flow with motion allowed first proves the probe can see animations at all.
    for (const mode of ['no-preference', 'reduce']) {
        const p = await openTarget(`${origin}/popup.html?view=tab#import`);
        await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: mode }] }, p.sessionId);
        await p.reload();
        await p.waitFor(`document.getElementById('export-panel')`);
        await gotoImportEmpty(p);
        await p.setFile('#import-file', smallPath);
        await p.waitFor(`document.getElementById('btn-import')`);
        await openSection(p, 'bookmark-options');
        await p.click('#im-bm-replace');
        const seen = [];
        await p.eval(`document.getElementById('btn-import').click();`);
        await p.waitFor(`document.getElementById('replace-confirm')`);
        seen.push(...await slowAnimations(p));
        await sleep(400);
        await p.click('#btn-replace-no');
        await p.click('#btn-menu');
        seen.push(...await slowAnimations(p));
        await p.press('Escape');
        await p.click('#btn-theme');
        seen.push(...await slowAnimations(p));
        await p.click('#btn-theme');
        if (mode === 'no-preference') check('motion probe sees animations when motion is allowed', seen.length > 0, seen.slice(0, 3).join(', '));
        else check('prefers-reduced-motion: no animation longer than 50ms or looping (dialog, menu, switches)', seen.length === 0, seen.join(', '));
        await cdp('Target.closeTarget', { targetId: p.targetId });
    }
}

async function reflowCheck() {
    console.log('Reflow / 200% zoom');
    const p = await openTarget(`${origin}/popup.html?view=tab#export`);
    await p.setTheme('light'); await p.reload();
    for (const [w, h, label] of [[640, 450, '200% zoom (640x450 CSS px)'], [320, 256, '400% zoom (320x256 CSS px)']]) {
        await cdp('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1280 / w, mobile: false }, p.sessionId);
        await sleep(300);
        for (const name of ['export', 'import', 'backups']) {
            await p.eval(`location.hash = '#${name}';`); await sleep(300);
            const r = await p.eval(`
              const out = [...document.querySelectorAll('button,input,select,[role=switch],[role=tab],[role=checkbox]')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && !e.closest('[hidden]') && getComputedStyle(e.closest('[role=tabpanel]') || e).display !== 'none'; })
                .filter(e => { const b = e.getBoundingClientRect(); return b.left < -1 || b.right > innerWidth + 1; }).map(e => e.id || e.getAttribute('aria-label') || e.textContent.trim().slice(0, 20));
              return { hscroll: document.documentElement.scrollWidth > innerWidth + 1, out, scrollable: [...document.querySelectorAll('*')].some(e => e.scrollHeight > e.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowY)) };`);
            check(`${label}: ${name} tab has no horizontal scroll or clipped controls`, !r.hscroll && r.out.length === 0, r.hscroll ? 'horizontal scroll' : r.out.join(', '));
        }
        if (w === 640) {
            await p.eval(`location.hash = '#export';`); await sleep(300);
            await audit(p, 'Tab: Export at 200% zoom', 'light');
        }
    }
    await cdp('Emulation.clearDeviceMetricsOverride', {}, p.sessionId);
    await cdp('Target.closeTarget', { targetId: p.targetId });
}

// ---------------------------------------------------------------- run
let fatal = null;
try {
    // Seed: a second tab so the popup flow has a normal window to be opened from.
    for (const theme of THEMES) {
        // The theme lives in localStorage of the extension origin; set it from a tab page, then every view picks it up.
        const setter = await openTarget(`${origin}/popup.html?view=tab#export`);
        await setter.setTheme(theme);
        await cdp('Target.closeTarget', { targetId: setter.targetId });

        const popup = await popupStates(theme);
        if (popup) {
            try { await popupBackupStates(popup, theme); await popupHeaderStates(popup, theme); }
            catch (e) { console.error(`  popup states failed: ${e.message}`); check(`popup state flow [${theme}]`, false, e.message); }
            await cdp('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
        }
        const tv = await tabViewStates(theme);
        await cdp('Target.closeTarget', { targetId: tv.targetId });
        await lazyStates(theme);
    }
    await keyboardChecks();
    await motionCheck();
    await reflowCheck();
} catch (e) {
    fatal = e;
    console.error('Audit aborted:', e.stack || e.message);
}

// ---------------------------------------------------------------- report
const allowed = (r) => r.impact === 'moderate' && ALLOW.some((a) => a.id === r.id && (!a.state || r.state.includes(a.state)) && a.reason);
const failing = rows.filter((r) => ['critical', 'serious'].includes(r.impact) || (r.impact === 'moderate' && !allowed(r)));
console.log(`\nAxe: ${audited} state audits, ${rows.length} violation row(s)`);
if (rows.length) {
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`${pad('rule', 26)}${pad('impact', 10)}${pad('nodes', 7)}state [theme]`);
    for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
        console.log(`${pad(r.id, 26)}${pad(r.impact, 10)}${pad(r.nodes, 7)}${r.state} [${r.theme}]${allowed(r) ? '  (allow-listed)' : ''}`);
    }
    console.log('\nDetails (first nodes):');
    const seen = new Set();
    for (const r of rows) {
        const key = `${r.id}|${r.sample[0]?.target}`;
        if (seen.has(key)) continue; seen.add(key);
        console.log(`- ${r.id} (${r.impact}): ${r.help}`);
        for (const n of r.sample) console.log(`    ${n.target}\n      ${n.html}\n      ${n.summary}`);
    }
}
if (process.env.VERBOSE && incompletes.length) {
    console.log('\nAxe "incomplete" (needs manual review):');
    for (const i of incompletes) console.log(`- ${i.id} x${i.nodes} in ${i.state} [${i.theme}]: ${i.sample?.target ?? ''}`);
}
if (exemptions.length) {
    console.log('\nRules switched off for a single state (documented axe false positives):');
    for (const e of exemptions.filter((e, i) => exemptions.findIndex((o) => o.rule === e.rule && o.state === e.state) === i)) console.log(`- ${e.rule} in "${e.state}": ${e.reason}`);
}
const failedChecks = checks.filter((c) => !c.ok);
console.log(`\nChecks: ${checks.length - failedChecks.length}/${checks.length} passed`);
for (const c of failedChecks) console.log(`  FAIL ${c.name}${c.detail ? ` - ${c.detail}` : ''}`);

ws.close();
const bad = failing.length > 0 || failedChecks.length > 0 || fatal;
console.log(bad ? `A11Y FAILED (${failing.length} blocking violation row(s), ${failedChecks.length} failed check(s)${fatal ? ', aborted' : ''})` : 'A11Y PASSED');
cleanup();
process.exit(bad ? 1 : 0);
