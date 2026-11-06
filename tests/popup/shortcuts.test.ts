// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { t } from '@/lib/i18n';
import { CHROME_INFO, IDLE_STATE, installI18n, renderApp, resetEnvironment, routeSend } from './helpers';

vi.mock('@/lib/messaging', () => ({ send: vi.fn() }));

const FIREFOX_INFO = { ...CHROME_INFO, key: 'firefox', name: 'Firefox', family: 'gecko' };
const BOUND = [
  { name: '_execute_action', description: '', shortcut: 'Ctrl+Shift+L' },
  { name: 'backup-now', description: 'Back up all tabs and bookmarks now', shortcut: '' },
  { name: 'save-window', description: 'Save the current window as a snapshot', shortcut: 'Ctrl+Shift+Comma' },
];

// The popup talks to the extension APIs through WXT's fakeBrowser in tests.
const fake = fakeBrowser as unknown as {
  commands?: { getAll: () => Promise<unknown>; openShortcutSettings?: () => Promise<void> };
  tabs: { create: (o: unknown) => Promise<unknown> };
};

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: t('menuMore') }));
  await user.click(await screen.findByRole('menuitem', { name: t('shortcutsMenu') }));
  return screen.findByRole('dialog', { name: t('shortcutsTitle') });
}

beforeEach(() => {
  installI18n();
  routeSend();
  fake.commands = { getAll: vi.fn(async () => BOUND) };
});
afterEach(() => {
  delete fake.commands;
  resetEnvironment();
});

describe('keyboard shortcuts dialog', () => {
  it('lists the shortcuts the browser actually assigned, and "Not set" for unassigned ones', async () => {
    const user = userEvent.setup();
    renderApp();
    const dialog = await openDialog(user);
    const rows = await waitFor(() => {
      const items = within(dialog).getAllByRole('listitem');
      expect(items).toHaveLength(3);
      return items;
    });
    expect(rows[0]?.textContent).toContain(t('shortcutOpenPopup'));
    expect(within(rows[0]!).getByLabelText('Ctrl+Shift+L')).toBeTruthy();
    expect(rows[1]?.textContent).toContain(t('shortcutNotSet'));
    // Period/Comma are shown as the characters people press.
    expect(within(within(rows[2]!).getByLabelText('Ctrl+Shift+Comma')).getByText(',')).toBeTruthy();
    expect(dialog.textContent).toContain(t('shortcutsHint'));
  });

  it('opens the Chromium shortcut settings page', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(fake.tabs, 'create').mockResolvedValue({});
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    renderApp();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: t('shortcutsChange') }));
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
    expect(close).toHaveBeenCalled();
  });

  it('uses openShortcutSettings on Firefox, or explains where to go', async () => {
    routeSend({ GET_STATE: () => ({ ok: true, browser: FIREFOX_INFO, importState: IDLE_STATE }) });
    const user = userEvent.setup();
    const open = vi.fn(async () => {});
    fake.commands = { getAll: vi.fn(async () => BOUND), openShortcutSettings: open };
    renderApp();
    await waitFor(() => expect(document.getElementById('browser-badge')?.textContent).toBe('Firefox'));
    let dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: t('shortcutsChange') }));
    expect(open).toHaveBeenCalled();

    // Older Firefox without the API: show where the setting lives.
    fake.commands = { getAll: vi.fn(async () => BOUND) };
    await user.keyboard('{Escape}');
    dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: t('shortcutsChange') }));
    expect(await within(dialog).findByText(t('shortcutsFirefoxHow'))).toBeTruthy();
  });

  it('says so when the shortcuts cannot be read', async () => {
    fake.commands = { getAll: vi.fn(async () => Promise.reject(new Error('nope'))) };
    const user = userEvent.setup();
    renderApp();
    const dialog = await openDialog(user);
    expect(await within(dialog).findByText(t('shortcutsLoadFailed'))).toBeTruthy();
  });
});
