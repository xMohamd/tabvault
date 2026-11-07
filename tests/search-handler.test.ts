// @ts-nocheck -- drives the background through the untyped fake browser.
import { beforeAll, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { createFakeBrowser } from './helpers/fake-browser';
import * as sched from '@/lib/backup-scheduler';
import background from '@/entrypoints/background';

const fb = createFakeBrowser({ family: 'chromium' });
delete URL.createObjectURL;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = (msg) => new Promise((resolve) => {
  const ret = fb.listeners.onMessage[0](msg, { id: 'fake-extension-id' }, resolve);
  if (ret !== true) resolve(undefined);
});

describe('SEARCH_SNAPSHOTS', () => {
  beforeAll(async () => {
    background.main();
    const w = fb.seedWindow({ focused: true }, [{ url: 'https://shared.example/', title: 'Shared page' }, 'https://first.example/']);
    fb.seedBookmark(fb.roots.bar, { title: 'Shared bookmark', url: 'https://shared.example/bm' });
    await sched.createSnapshot('manual');
    await sleep(5);
    // Second state: one tab replaced, the shared page stays (now in a group).
    const [shared, first] = w.tabs;
    await browser.tabs.remove(first.id);
    await browser.tabs.create({ windowId: w.id, url: 'https://second.example/shared-docs' });
    const gid = await browser.tabs.group({ tabIds: [shared.id], createProperties: { windowId: w.id } });
    await browser.tabGroups.update(gid, { title: 'Reading', color: 'green' });
    await sched.createSnapshot('quick', { scope: { windowId: w.id, title: 'My window' } });
  });

  it('reads the index and every body with one storage call', async () => {
    let calls = 0;
    const area = browser.storage.local;
    const get = area.get.bind(area);
    area.get = (...a) => { calls++; return get(...a); };
    const all = await sched.getAllSnapshots();
    area.get = get;
    expect(all).toHaveLength(2);
    expect(all[0].meta.reason).toBe('quick'); // newest first
    expect(calls).toBe(2); // the index, then all bodies together
  });

  it('finds a page once with all its sources and the newest details', async () => {
    const reply = await call({ type: 'SEARCH_SNAPSHOTS', query: 'shared.example' });
    expect(reply.ok).toBe(true);
    expect(reply.searched).toBe(2);
    const tabResult = reply.results.find((r) => r.kind === 'tab');
    expect(reply.results.filter((r) => r.kind === 'tab')).toHaveLength(1);
    expect(tabResult.sources).toHaveLength(2);
    expect(tabResult.group).toEqual({ title: 'Reading', color: 'green' }); // from the newer quick save
    expect(tabResult.sources[0].label).toMatch(/^My window/);
    expect(tabResult.sources[1].label).toMatch(/^(Manual|reasonManual)/);
    const bookmark = reply.results.find((r) => r.kind === 'bookmark');
    expect(bookmark.folderPath.at(-1)).toBe('Bookmarks bar');
    expect(bookmark.sources).toHaveLength(2); // bookmarks are in both snapshots
  });

  it('matches words in the title or the address, honors the limit and reports the total', async () => {
    const reply = await call({ type: 'SEARCH_SNAPSHOTS', query: 'shared docs', limit: 1 });
    expect(reply.ok).toBe(true);
    expect(reply.results).toHaveLength(1);
    expect(reply.total).toBe(1);
    expect(reply.results[0].url).toBe('https://second.example/shared-docs');
    const capped = await call({ type: 'SEARCH_SNAPSHOTS', query: 'shared', limit: 1 });
    expect(capped.results).toHaveLength(1);
    expect(capped.total).toBeGreaterThan(1);
  });

  it('searches only the snapshots in `ids` and reports how many were searched and how many exist', async () => {
    const [newest, oldest] = await sched.listSnapshots().then((l) => [...l].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    const all = await call({ type: 'SEARCH_SNAPSHOTS', query: 'shared' });
    expect(all).toMatchObject({ ok: true, searched: 2, available: 2 });

    const onlyOld = await call({ type: 'SEARCH_SNAPSHOTS', query: 'shared', ids: [oldest.id] });
    expect(onlyOld).toMatchObject({ ok: true, searched: 1, available: 2 });
    expect(onlyOld.results.every((r) => r.sources.length === 1 && r.sources[0].id === oldest.id)).toBe(true);
    // "second.example/shared-docs" was only open when the newer snapshot was taken.
    expect(onlyOld.results.some((r) => r.url.includes('second.example'))).toBe(false);
    const onlyNew = await call({ type: 'SEARCH_SNAPSHOTS', query: 'shared', ids: [newest.id] });
    expect(onlyNew.results.some((r) => r.url.includes('second.example'))).toBe(true);

    // Unknown ids are ignored; an empty list searches nothing; undefined means all.
    expect(await call({ type: 'SEARCH_SNAPSHOTS', query: 'shared', ids: ['nope', newest.id] })).toMatchObject({ searched: 1, available: 2 });
    expect(await call({ type: 'SEARCH_SNAPSHOTS', query: 'shared', ids: [] })).toMatchObject({ ok: true, results: [], total: 0, searched: 0, available: 2 });
    expect(await call({ type: 'SEARCH_SNAPSHOTS', query: 'shared', ids: undefined })).toMatchObject({ searched: 2, available: 2 });
  });

  it('answers an empty query and a store without snapshots', async () => {
    expect(await call({ type: 'SEARCH_SNAPSHOTS', query: '  ' })).toMatchObject({ ok: true, results: [], total: 0, searched: 2 });
    for (const m of await sched.listSnapshots()) await sched.deleteSnapshot(m.id);
    expect(await call({ type: 'SEARCH_SNAPSHOTS', query: 'shared' })).toMatchObject({ ok: true, results: [], total: 0, searched: 0 });
  });
});
