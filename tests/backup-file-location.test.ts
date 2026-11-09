/**
 * Where automatic backup files go: a folder inside Downloads, or a folder the user
 * picked (File System Access). The picked folder is an in-memory fake here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '../src/lib/backup-scheduler';
import type { ScheduleSettings } from '../src/lib/types';
import { createFakeBrowser } from './helpers/fake-browser';

const folderState = vi.hoisted(() => ({
  folder: null as null | { id: string; handle: { name: string } },
  access: 'granted' as 'granted' | 'prompt' | 'denied',
  files: new Map<string, string>(),
  failWrite: false,
}));

vi.mock('../src/lib/backup-folder', () => ({
  getBackupFolder: async () => folderState.folder,
  folderAccess: async () => folderState.access,
  writeFolderFile: async (_dir: unknown, name: string, text: string) => {
    if (folderState.failWrite) throw new Error('disk full');
    folderState.files.set(name, text);
    return name;
  },
  removeFolderFile: async (_dir: unknown, name: string) => {
    folderState.files.delete(name);
  },
}));

const fb = createFakeBrowser();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const must = <T>(v: T | null | undefined): T => {
  if (v == null) throw new Error('expected a value');
  return v;
};
const downloads = () => fb.downloads as Array<{ filename: string }>;
const calls = fb.calls as unknown as { downloadsRemoveFile?: number[] };

let n = 0;
async function reset(settings: Partial<ScheduleSettings>) {
  fb.reset();
  folderState.folder = { id: 'f1', handle: { name: 'My Backups' } };
  folderState.access = 'granted';
  folderState.files.clear();
  folderState.failWrite = false;
  m._setExporterFactory(() => ({
    async export() {
      return {
        data: { schemaVersion: '1.1', exportedAt: null, source: {}, windows: [{ n: ++n }] as never, bookmarks: [] },
        stats: { windows: 1, tabs: 1, groups: 0, bookmarks: 0, skippedTabs: 0 },
      };
    },
  }));
  await m.saveSettings({ keep: 2, saveToFiles: true, ...settings });
}
const run = async () => must(await m.handleAlarm({ name: m.SCHEDULE_ALARM }));

describe('backup file location settings', () => {
  beforeEach(() => fb.reset());

  it('defaults to Downloads/TabVault', async () => {
    expect(await m.getSettings()).toMatchObject({ fileLocation: 'downloads', downloadsFolder: 'TabVault' });
  });

  it('keeps folder names inside Downloads and safe', () => {
    const s = m.sanitizeDownloadsFolder;
    expect(s('Backups/Tabs')).toBe('Backups/Tabs');
    expect(s('  My <Tabs>?  ')).toBe('My Tabs');
    expect(s('/abs/../path\\x')).toBe('abs/path/x');
    expect(s('../..')).toBe('TabVault');
    expect(s('C:\\Users\\me')).toBe('C/Users/me');
    expect(s('a/b/c/d/e/f')).toBe('a/b/c/d');
    expect(s('')).toBe('TabVault');
    expect(s(42)).toBe('TabVault');
  });

  it('validates the stored location', async () => {
    expect(await m.saveSettings({ fileLocation: 'nowhere' as never, downloadsFolder: ' ../ ' })).toMatchObject({
      fileLocation: 'downloads',
      downloadsFolder: 'TabVault',
    });
    expect(await m.saveSettings({ fileLocation: 'folder', downloadsFolder: 'Tabs' })).toMatchObject({
      fileLocation: 'folder',
      downloadsFolder: 'Tabs',
    });
  });
});

describe('writing backup files', () => {
  it('uses the chosen folder inside Downloads', async () => {
    await reset({ fileLocation: 'downloads', downloadsFolder: 'Backups/Tabs' });
    const meta = await run();
    expect(downloads()[0]?.filename).toMatch(/^Backups\/Tabs\/tabs-backup-[\d_-]+\.json$/);
    expect(meta.file).toEqual({ downloadId: 1, filename: downloads()[0]?.filename });
    expect(folderState.files.size).toBe(0);
  });

  it('writes into the picked folder and records which folder', async () => {
    await reset({ fileLocation: 'folder' });
    const meta = await run();
    expect(downloads()).toHaveLength(0);
    const [name] = [...folderState.files.keys()];
    expect(name).toMatch(/^tabs-backup-[\d_-]+\.json$/);
    expect(JSON.parse(must(folderState.files.get(must(name)))).schemaVersion).toBe('1.1');
    expect(meta.file).toEqual({ filename: name, folderId: 'f1' });
    expect(await m.getLastRun()).toEqual({ at: expect.any(String), ok: true });
  });

  it.each([
    ['access', () => void (folderState.access = 'prompt')],
    ['missing', () => void (folderState.folder = null)],
    ['failed', () => void (folderState.failWrite = true)],
  ] as Array<[string, () => void]>)('falls back to Downloads when the folder cannot be used (%s)', async (reason, breakIt) => {
    await reset({ fileLocation: 'folder', downloadsFolder: 'Tabs' });
    breakIt();
    const meta = await run();
    expect(folderState.files.size).toBe(0);
    expect(downloads()[0]?.filename).toMatch(/^Tabs\/tabs-backup-/);
    expect(meta.file?.downloadId).toBe(1);
    expect(await m.getLastRun()).toEqual({ at: expect.any(String), ok: true, fileFallback: reason });
  });

  it('pruning deletes old files from the picked folder', async () => {
    await reset({ fileLocation: 'folder' });
    const first = await run();
    await sleep(1100); // names have one-second resolution
    await run();
    await sleep(1100);
    await run(); // keep=2: the first is pruned
    expect(folderState.files.has(must(first.file).filename)).toBe(false);
    expect(folderState.files.size).toBe(2);
    expect(calls.downloadsRemoveFile ?? []).toHaveLength(0);
  });

  it('pruning leaves files alone after another folder was picked', async () => {
    await reset({ fileLocation: 'folder' });
    const first = await run();
    folderState.folder = { id: 'f2', handle: { name: 'Elsewhere' } };
    await sleep(1100);
    await run();
    await sleep(1100);
    await run();
    expect(folderState.files.has(must(first.file).filename)).toBe(true);
  });
});
