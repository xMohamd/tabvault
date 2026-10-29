import { beforeAll, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import * as m from '../src/lib/backup-scheduler';
import type { BrowserInfo } from '../src/lib/browser-detect';
import type { SnapshotReason } from '../src/lib/types';
import { createFakeBrowser } from './helpers/fake-browser';

const fb = createFakeBrowser();

let content = 0;
let fail = false;
const chromeInfo = { key: 'chrome' } as BrowserInfo;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alarm = () => fb.alarms.get(m.SCHEDULE_ALARM) as { periodInMinutes?: number } | undefined;
const must = <T>(v: T | null | undefined): T => {
  if (v == null) throw new Error('expected a value');
  return v;
};

// Scheduler state is module-level and the tests below build on each other, so they run in order.
describe('backup scheduler', () => {
  let creates = 0;
  beforeAll(() => {
    const orig = browser.alarms.create.bind(browser.alarms) as (...a: unknown[]) => Promise<void>;
    vi.spyOn(browser.alarms, 'create').mockImplementation((async (...a: unknown[]) => {
      creates++;
      return orig(...a);
    }) as never);
    m._setExporterFactory(() => ({
      async export(opts) {
        if (fail) throw new Error('boom');
        return {
          data: {
            schemaVersion: '1.1',
            exportedAt: new Date().toISOString(),
            source: {},
            windows: [{ n: content }] as never,
            bookmarks: opts.includeBookmarks ? ([1] as never) : [],
          },
          stats: { windows: 1, tabs: 1, groups: 0, bookmarks: 0, skippedTabs: 0 },
        };
      },
    }));
  });

  it('returns defaults and validates settings before touching alarms', async () => {
    expect(await m.getSettings()).toEqual(m.DEFAULT_SETTINGS);
    await expect(m.saveSettings({ keep: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(m.saveSettings({ keep: 51 })).rejects.toBeInstanceOf(RangeError);
    await expect(m.saveSettings({ frequency: 'yearly' as never })).rejects.toBeInstanceOf(RangeError);
    expect(creates).toBe(0);
  });

  it('manages the alarm', async () => {
    const s = await m.saveSettings({ enabled: true, frequency: 'hourly', keep: 2 });
    expect(s.keep).toBe(2);
    expect(alarm()?.periodInMinutes).toBe(60);
    await m.ensureAlarm();
    await m.ensureAlarm();
    expect(creates).toBe(1); // ensureAlarm is idempotent
    await m.saveSettings({ frequency: 'weekly' });
    expect(alarm()?.periodInMinutes).toBe(10080);
    expect(creates).toBe(2);
    await m.saveSettings({ enabled: false });
    expect(alarm()).toBeUndefined();
    await m.saveSettings({ enabled: true, frequency: 'daily' });
    expect(alarm()?.periodInMinutes).toBe(1440);
  });

  it('creates snapshots and prunes per category (manual vs pre-*)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      content++;
      ids.push(must(await m.createSnapshot('manual', { browser: chromeInfo })).id);
      await sleep(3);
    }
    for (let i = 0; i < 5; i++) {
      content++;
      ids.push(must(await m.createSnapshot('pre-replace', { browser: chromeInfo })).id);
      await sleep(3);
    }
    const list = await m.listSnapshots();
    expect(list.filter((x) => ['manual', 'scheduled'].includes(x.reason))).toHaveLength(2); // keep=2
    expect(list.filter((x) => x.reason === 'pre-replace')).toHaveLength(3); // pre-* capped at 3
    // newest first
    expect(list.map((x) => x.id)).toEqual([...ids].reverse().filter((id) => list.some((l) => l.id === id)));
    // pruned bodies removed
    expect(Object.keys(fb.storage.local).filter((k) => k.startsWith('snapshot:'))).toHaveLength(5);
    const first = must(list[0]);
    expect(first.bytes).toBeGreaterThan(0);
    expect(first.hash).toHaveLength(8);
    expect(await m.getSnapshot(must(ids[0]))).toBeNull();
    expect(await m.getSnapshot(must(ids[8]))).toBeTruthy();
  });

  it('scheduled run skips unchanged content, snapshots changed content, ignores other alarms', async () => {
    const before = (await m.listSnapshots()).length;
    let r = await m.handleAlarm({ name: m.SCHEDULE_ALARM });
    expect(r).toBeNull();
    expect(await m.listSnapshots()).toHaveLength(before);
    expect((await m.getLastRun())?.skipped).toBe('unchanged');
    content++;
    r = await m.handleAlarm({ name: m.SCHEDULE_ALARM });
    expect(r?.reason).toBe('scheduled');
    expect((await m.getLastRun())?.ok).toBe(true);
    expect(await m.handleAlarm({ name: 'other' })).toBeNull();
  });

  it('serialises concurrent snapshots (unique ids, none lost)', async () => {
    content++;
    await Promise.all([1, 2, 3].map(() => m.createSnapshot('pre-import', { browser: chromeInfo })));
    const list = await m.listSnapshots();
    expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    expect(list.filter((x) => x.reason.startsWith('pre-'))).toHaveLength(3);
  });

  it('deletes snapshots', async () => {
    const list = await m.listSnapshots();
    const target = must(list[0]);
    await m.deleteSnapshot(target.id);
    expect(await m.listSnapshots()).toHaveLength(list.length - 1);
    expect(await m.getSnapshot(target.id)).toBeNull();
  });

  it('records failures and does not poison the queue', async () => {
    fail = true;
    content++;
    const r = await m.handleAlarm({ name: m.SCHEDULE_ALARM });
    expect(r).toBeNull();
    const lr = must(await m.getLastRun());
    expect(lr.ok).toBe(false);
    expect(lr.error).toBe('boom');
    await expect(m.createSnapshot('manual', { browser: chromeInfo })).rejects.toThrow(/boom/);
    fail = false;
    await m.createSnapshot('manual', { browser: chromeInfo });
    await expect(m.createSnapshot('bogus' as SnapshotReason, { browser: chromeInfo })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('scheduler through the real exporter', () => {
  it('snapshots the fake browser', async () => {
    m._setExporterFactory(); // restore the default exporter
    fb.reset();
    (fb as unknown as { seedWindow: (o: object, t: string[]) => unknown }).seedWindow({ focused: true }, [
      'https://a.example/',
      'https://b.example/',
    ]);
    await m.saveSettings({ enabled: true, frequency: 'daily', keep: 3 });
    expect(fb.alarms.has(m.SCHEDULE_ALARM)).toBe(true);
    const real: BrowserInfo = {
      key: 'chrome', name: 'Chrome', family: 'chromium',
      features: {
        tabGroups: true, groupColors: true, groupCollapse: true, bookmarks: true, downloads: true,
        discard: true, discardOnCreate: false, alarms: true, sessionStorage: true,
      },
    };
    const s1 = must(await m.createSnapshot('manual', { browser: real }));
    expect(s1.stats.tabs).toBeGreaterThan(0);
    const snap = must(await m.getSnapshot(s1.id));
    expect(Array.isArray(snap.windows)).toBe(true);
  });
});
