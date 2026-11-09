// @vitest-environment happy-dom
/** Backups tab: choosing where automatic backup files go. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { t } from '@/lib/i18n';
import { callsOf, installI18n, renderApp, resetEnvironment, routeSend } from './helpers';

vi.mock('@/lib/messaging', () => ({ send: vi.fn() }));

const folderState = vi.hoisted(() => ({
  folder: null as null | { id: string; handle: { name: string } },
  access: 'granted' as 'granted' | 'prompt' | 'denied',
  requested: 0,
}));

vi.mock('@/lib/backup-folder', () => ({
  folderPickerSupported: () => typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function',
  getBackupFolder: async () => folderState.folder,
  setBackupFolder: async (handle: { name: string }) => {
    folderState.folder = { id: 'new', handle };
    return folderState.folder;
  },
  clearBackupFolder: async () => {
    folderState.folder = null;
  },
  folderAccess: async () => folderState.access,
  requestFolderAccess: async () => {
    folderState.requested++;
    folderState.access = 'granted';
    return 'granted';
  },
}));

const fake = fakeBrowser as unknown as { tabs: { create: (o: unknown) => Promise<unknown> } };
const g = globalThis as { showDirectoryPicker?: unknown };
type User = ReturnType<typeof userEvent.setup>;

const base = { enabled: true, frequency: 'daily', keep: 7, includeBookmarks: true, saveToFiles: true };
const location = (overrides: Record<string, unknown> = {}) => ({ ...base, fileLocation: 'downloads', downloadsFolder: 'TabVault', ...overrides });
const echoSettings = (payload: Record<string, unknown>) => ({ ok: true, settings: { ...location(), ...(payload.settings as object) } });

async function openSettings(user: User, settings: Record<string, unknown>, lastRun: unknown = null) {
  routeSend({
    SNAPSHOTS_LIST: () => ({ ok: true, snapshots: [], settings, lastRun }),
    SCHEDULE_SET: echoSettings,
  });
  renderApp();
  await user.click(screen.getByRole('tab', { name: t('tabBackups') }));
  await waitFor(() => expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(1));
  await user.click(screen.getByRole('button', { name: new RegExp(t('autoTitle')) }));
}
const path = () => document.getElementById('bk-location-path')?.textContent;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement | null;

beforeEach(() => {
  installI18n();
  folderState.folder = null;
  folderState.access = 'granted';
  folderState.requested = 0;
});
afterEach(() => {
  delete g.showDirectoryPicker;
  vi.restoreAllMocks();
  resetEnvironment();
});

describe('backup file location', () => {
  it('is shown only when files are saved, with the default marked', async () => {
    const user = userEvent.setup();
    await openSettings(user, location({ saveToFiles: false }));
    expect(document.getElementById('bk-location')).toBeNull();
    await user.click(document.getElementById('bk-files') as HTMLElement);
    await waitFor(() => expect(path()).toBe('Downloads/TabVault'));
    expect(document.getElementById('bk-location')?.textContent).toContain(t('fileLocationDefaultBadge'));
  });

  describe('without a folder picker (Firefox)', () => {
    it('saves a folder inside Downloads and can go back to the default', async () => {
      const user = userEvent.setup();
      await openSettings(user, location());
      expect(button('bk-choose-folder')).toBeNull();
      expect(screen.getByText(t('fileLocationSubfolderHint'))).toBeTruthy();
      const input = document.getElementById('bk-subfolder') as HTMLInputElement;
      await user.clear(input);
      await user.type(input, 'Backups/Tabs{Enter}');
      await waitFor(() => expect(callsOf('SCHEDULE_SET').at(-1)?.settings.downloadsFolder).toBe('Backups/Tabs'));
      await waitFor(() => expect(path()).toBe('Downloads/Backups/Tabs'));

      await user.click(must(button('bk-default-folder')));
      await waitFor(() =>
        expect(callsOf('SCHEDULE_SET').at(-1)?.settings).toMatchObject({ fileLocation: 'downloads', downloadsFolder: 'TabVault' }),
      );
      await waitFor(() => expect(path()).toBe('Downloads/TabVault'));
    });

    it('an emptied field keeps the saved folder', async () => {
      const user = userEvent.setup();
      await openSettings(user, location({ downloadsFolder: 'Tabs' }));
      const input = document.getElementById('bk-subfolder') as HTMLInputElement;
      await user.clear(input);
      await user.tab();
      expect(input.value).toBe('Tabs');
      expect(callsOf('SCHEDULE_SET')).toHaveLength(0);
    });
  });

  describe('with a folder picker (Chromium)', () => {
    it('in the popup, opens the full-tab view on these settings', async () => {
      g.showDirectoryPicker = vi.fn();
      const create = vi.spyOn(fake.tabs, 'create').mockResolvedValue({});
      vi.spyOn(window, 'close').mockImplementation(() => {});
      const user = userEvent.setup();
      await openSettings(user, location());
      expect(screen.getByText(t('fileLocationOpensTab'))).toBeTruthy();
      await user.click(must(button('bk-choose-folder')));
      expect(g.showDirectoryPicker).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledWith({ url: expect.stringMatching(/popup\.html\?view=tab&section=backups-auto#backups$/) });
    });

    it('in the tab view, picks a folder and saves it as the location', async () => {
      history.replaceState(null, '', '/?view=tab&section=backups-auto');
      g.showDirectoryPicker = vi.fn().mockResolvedValue({ name: 'My Backups' });
      const user = userEvent.setup();
      routeSend({ SNAPSHOTS_LIST: () => ({ ok: true, snapshots: [], settings: location(), lastRun: null }), SCHEDULE_SET: echoSettings });
      renderApp();
      await user.click(screen.getByRole('tab', { name: t('tabBackups') }));
      // The section opens by itself when the tab view was opened for it.
      const choose = await waitFor(() => must(button('bk-choose-folder')));
      await user.click(choose);
      expect(g.showDirectoryPicker).toHaveBeenCalledWith(expect.objectContaining({ mode: 'readwrite' }));
      await waitFor(() => expect(callsOf('SCHEDULE_SET').at(-1)?.settings.fileLocation).toBe('folder'));
      await waitFor(() => expect(path()).toBe('My Backups'));
      expect(folderState.folder?.handle.name).toBe('My Backups');
      expect(button('bk-default-folder')).toBeTruthy();
    });

    it('closing the picker changes nothing', async () => {
      history.replaceState(null, '', '/?view=tab');
      g.showDirectoryPicker = vi.fn().mockRejectedValue(new DOMException('closed', 'AbortError'));
      const user = userEvent.setup();
      await openSettings(user, location());
      await user.click(must(button('bk-choose-folder')));
      expect(callsOf('SCHEDULE_SET')).toHaveLength(0);
      expect(path()).toBe('Downloads/TabVault');
    });

    it('asks to allow access again when the permission was lost', async () => {
      history.replaceState(null, '', '/?view=tab');
      g.showDirectoryPicker = vi.fn();
      folderState.folder = { id: 'f1', handle: { name: 'My Backups' } };
      folderState.access = 'prompt';
      const user = userEvent.setup();
      await openSettings(user, location({ fileLocation: 'folder' }));
      await waitFor(() => expect(path()).toBe('My Backups'));
      expect(document.getElementById('bk-location-warning')?.textContent).toBe(t('fileLocationNeedsAccess', 'Downloads/TabVault'));
      await user.click(must(button('bk-allow-folder')));
      expect(folderState.requested).toBe(1);
      await waitFor(() => expect(document.getElementById('bk-location-warning')).toBeNull());
      expect(button('bk-allow-folder')).toBeNull();
    });

    it('"Use default" forgets the picked folder', async () => {
      history.replaceState(null, '', '/?view=tab');
      g.showDirectoryPicker = vi.fn();
      folderState.folder = { id: 'f1', handle: { name: 'My Backups' } };
      const user = userEvent.setup();
      await openSettings(user, location({ fileLocation: 'folder' }));
      await waitFor(() => expect(path()).toBe('My Backups'));
      await user.click(must(button('bk-default-folder')));
      await waitFor(() => expect(path()).toBe('Downloads/TabVault'));
      expect(callsOf('SCHEDULE_SET').at(-1)?.settings.fileLocation).toBe('downloads');
      expect(folderState.folder).toBeNull();
    });
  });

  it('the last run says when the file went to Downloads instead', async () => {
    const user = userEvent.setup();
    await openSettings(user, location({ fileLocation: 'folder' }), { at: '2025-02-03T10:00:00.000Z', ok: true, fileFallback: 'access' });
    const text = document.getElementById('bk-last-run')?.textContent ?? '';
    expect(text).toMatch(/was saved to Downloads, because the chosen folder couldn't be used/);
  });
});

function must<T>(v: T | null | undefined): T {
  if (v == null) throw new Error('expected a value');
  return v;
}
