import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { _resetBrowserCache } from '../src/lib/browser-detect';
import { createSnapshot } from '../src/lib/backup-scheduler';
import {
  BADGE_CLEAR_MS,
  BADGE_ERROR_COLOR,
  BADGE_OK_COLOR,
  createMenus,
  handleCommand,
  handleMenuClick,
  registerQuickActions,
} from '../src/lib/quick-actions';
import messages from '../public/_locales/en/messages.json';
import { createFakeBrowser } from './helpers/fake-browser';

vi.mock('../src/lib/backup-scheduler', () => ({ createSnapshot: vi.fn() }));

type Table = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;

/** browser.i18n over the real messages.json (Chrome placeholder semantics). */
function installI18n(): void {
  const table = messages as Table;
  const getMessage = (key: string, subs?: string | string[]) => {
    const entry = table[key];
    if (!entry) return '';
    const list = subs === undefined ? [] : Array.isArray(subs) ? subs : [subs];
    let text = entry.message;
    for (const [name, p] of Object.entries(entry.placeholders ?? {})) {
      const index = Number(/\$(\d)/.exec(p.content)?.[1] ?? 0);
      text = text.replace(new RegExp(`\\$${name}\\$`, 'gi'), list[index - 1] ?? '');
    }
    return text;
  };
  (browser as unknown as { i18n: unknown }).i18n = { getMessage, getUILanguage: () => 'en' };
}

const snapshot = vi.mocked(createSnapshot);

type Spec = string | { url: string; title?: string; active?: boolean };
/** The slice of the (untyped) fake browser these tests use. */
interface Fake {
  seedWindow(opts: { focused?: boolean }, tabs: Spec[]): { window: { id: number }; tabs: Array<{ id: number }> };
  seedGroup(tabIds: number[], opts: { title: string }): number;
  menus: Array<{ id: string; title: string; contexts: string[] }>;
  badge: { text: string; color: string; title: string };
  listeners: {
    onInstalled: Array<(details: { reason: string }) => void>;
    onMenuClicked: Array<(info: { menuItemId: string }, tab?: unknown) => void>;
    onCommand: Array<(command: string, tab?: unknown) => void>;
  };
}
let fb = createFakeBrowser() as unknown as Fake;

function setup(family: 'chromium' | 'gecko' = 'chromium') {
  fb = createFakeBrowser({ family }) as unknown as Fake;
  _resetBrowserCache();
  installI18n();
  snapshot.mockReset();
  snapshot.mockResolvedValue(null);
  registerQuickActions();
}

/** A window with an active "Docs" tab and a second tab, optionally grouped. */
function seed(grouped?: { title: string }) {
  const { window: win, tabs } = fb.seedWindow({ focused: true }, [
    { url: 'https://docs.example/', title: 'Docs', active: true },
    { url: 'https://b.example/', title: 'B' },
  ]);
  const groupId = grouped ? fb.seedGroup(tabs.map((t) => t.id), grouped) : -1;
  return { win, tabs: tabs.map((t) => ({ ...t })), groupId };
}

const chromeInfo = expect.objectContaining({ key: 'chrome' });

beforeEach(() => setup());
afterEach(() => {
  vi.useRealTimers();
});

describe('menus', () => {
  it('creates both items when the extension is installed', async () => {
    fb.listeners.onInstalled[0]?.({ reason: 'install' });
    await vi.waitFor(() => expect(fb.menus).toHaveLength(2));
    expect(fb.menus.map((m) => m.id)).toEqual(['save-window', 'save-group']);
    expect(fb.menus[0]).toMatchObject({
      title: 'Save this window as a snapshot',
      contexts: ['action', 'page'],
    });
    expect(fb.menus[1]?.title).toBe('Save this tab group as a snapshot');
  });

  it('recreates the items on update instead of failing on duplicate ids', async () => {
    await createMenus();
    await createMenus();
    expect(fb.menus).toHaveLength(2);
  });

  it('adds the tab-strip context on Firefox', async () => {
    setup('gecko');
    await createMenus();
    expect(fb.menus[0]?.contexts).toEqual(['action', 'page', 'tab']);
  });

  it('falls back to the common contexts when Firefox rejects "tab"', async () => {
    setup('gecko');
    const create = browser.contextMenus.create as unknown as (o: { contexts: string[] }) => unknown;
    const real = create.bind(browser.contextMenus);
    vi.spyOn(browser.contextMenus, 'create').mockImplementation(((o: { contexts: string[] }) => {
      if (o.contexts.includes('tab')) throw new Error("Invalid value for contexts: 'tab'");
      return real(o);
    }) as never);
    await createMenus();
    expect(fb.menus).toHaveLength(2);
    expect(fb.menus[0]?.contexts).toEqual(['action', 'page']);
  });

  it('does not add the tab context on Chrome', async () => {
    await createMenus();
    expect(fb.menus.every((m) => !m.contexts.includes('tab'))).toBe(true);
  });
});

describe('save window', () => {
  it('saves the window of the clicked tab, titled after its active tab', async () => {
    const { win, tabs } = seed();
    await handleMenuClick({ menuItemId: 'save-window' }, tabs[1] as never);
    expect(snapshot).toHaveBeenCalledWith('quick', {
      browser: chromeInfo,
      includeBookmarks: false,
      scope: { windowId: win.id, title: 'Window: Docs' },
    });
  });

  it('uses the last focused window when no tab is given', async () => {
    const { win } = seed();
    fb.seedWindow({}, ['https://other.example/']);
    await handleMenuClick({ menuItemId: 'save-window' });
    expect(snapshot.mock.calls[0]?.[1]?.scope?.windowId).toBe(win.id);
  });

  it('truncates long titles to 60 characters', async () => {
    const { tabs } = fb.seedWindow({ focused: true }, [{ url: 'https://x.example/', title: 'x'.repeat(200), active: true }]);
    await handleMenuClick({ menuItemId: 'save-window' }, tabs[0] as never);
    const title = snapshot.mock.calls[0]?.[1]?.scope?.title ?? '';
    expect(title).toBe(`Window: ${'x'.repeat(59)}…`);
  });

  it('labels a window whose active tab has no title', async () => {
    const { tabs } = fb.seedWindow({ focused: true }, [{ url: 'https://x.example/', title: '', active: true }]);
    await handleMenuClick({ menuItemId: 'save-window' }, tabs[0] as never);
    expect(snapshot.mock.calls[0]?.[1]?.scope?.title).toBe('Window: Window');
  });

  it('ignores unknown menu items', async () => {
    await handleMenuClick({ menuItemId: 'something-else' });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('is wired to contextMenus.onClicked', async () => {
    const { win, tabs } = seed();
    fb.listeners.onMenuClicked[0]?.({ menuItemId: 'save-window' }, tabs[0]);
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
    expect(snapshot.mock.calls[0]?.[1]?.scope).toMatchObject({ windowId: win.id });
  });
});

describe('save group', () => {
  it("saves the clicked tab's group, titled after the group", async () => {
    const { tabs, groupId } = seed({ title: 'Research' });
    await handleMenuClick({ menuItemId: 'save-group' }, tabs[1] as never);
    expect(snapshot).toHaveBeenCalledWith('quick', {
      browser: chromeInfo,
      includeBookmarks: false,
      scope: { groupId, title: 'Research' },
    });
  });

  it('calls an untitled group "Untitled group"', async () => {
    const { tabs, groupId } = seed({ title: '' });
    await handleMenuClick({ menuItemId: 'save-group' }, tabs[0] as never);
    expect(snapshot.mock.calls[0]?.[1]?.scope).toEqual({ groupId, title: 'Untitled group' });
  });

  it('uses the active tab when no tab is given', async () => {
    const { groupId } = seed({ title: 'Research' });
    await handleMenuClick({ menuItemId: 'save-group' });
    expect(snapshot.mock.calls[0]?.[1]?.scope).toEqual({ groupId, title: 'Research' });
  });

  it('saves the window instead when the tab is not in a group, and says so', async () => {
    const { win, tabs } = seed();
    await handleMenuClick({ menuItemId: 'save-group' }, tabs[0] as never);
    expect(snapshot.mock.calls[0]?.[1]?.scope).toEqual({ windowId: win.id, title: 'Window: Docs' });
    expect(fb.badge.text).toBe('✓');
    expect(fb.badge.title).toContain('not in a group');
  });
});

describe('keyboard shortcuts', () => {
  it('backup-now takes a full manual snapshot', async () => {
    await handleCommand('backup-now');
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledWith('manual', { browser: chromeInfo });
  });

  it('save-window quick-saves the window of the active tab', async () => {
    const { win, tabs } = seed();
    await handleCommand('save-window', tabs[0] as never);
    expect(snapshot).toHaveBeenCalledWith('quick', {
      browser: chromeInfo,
      includeBookmarks: false,
      scope: { windowId: win.id, title: 'Window: Docs' },
    });
  });

  it('save-window falls back to the focused window without a tab argument', async () => {
    const { win } = seed();
    await handleCommand('save-window');
    expect(snapshot.mock.calls[0]?.[1]?.scope?.windowId).toBe(win.id);
  });

  it('ignores other commands (the action shortcut is handled by the browser)', async () => {
    await handleCommand('_execute_action');
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('is wired to commands.onCommand', async () => {
    fb.listeners.onCommand[0]?.('backup-now');
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledWith('manual', expect.anything()));
  });
});

describe('badge feedback', () => {
  it('shows a teal check, then clears it', async () => {
    vi.useFakeTimers();
    const { tabs } = seed();
    await handleMenuClick({ menuItemId: 'save-window' }, tabs[0] as never);
    expect(fb.badge).toMatchObject({ text: '✓', color: BADGE_OK_COLOR, title: 'Saved to Backups: Window: Docs' });

    await vi.advanceTimersByTimeAsync(BADGE_CLEAR_MS - 1);
    expect(fb.badge.text).toBe('✓');
    await vi.advanceTimersByTimeAsync(1);
    expect(fb.badge.text).toBe('');
    expect(fb.badge.title).toBe('TabVault');
  });

  it('shows a red "!" with the reason when saving fails', async () => {
    vi.useFakeTimers();
    snapshot.mockRejectedValue(new Error('storage full'));
    const { tabs } = seed();
    await handleMenuClick({ menuItemId: 'save-window' }, tabs[0] as never);
    expect(fb.badge).toMatchObject({ text: '!', color: BADGE_ERROR_COLOR });
    expect(fb.badge.title).toContain('storage full');
    await vi.advanceTimersByTimeAsync(BADGE_CLEAR_MS);
    expect(fb.badge.text).toBe('');
  });

  it('fails visibly when there is no window to save', async () => {
    vi.useFakeTimers();
    await handleMenuClick({ menuItemId: 'save-window' }); // no windows seeded
    expect(fb.badge.text).toBe('!');
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('a newer outcome is not wiped by the older timer', async () => {
    vi.useFakeTimers();
    const { tabs } = seed();
    await handleMenuClick({ menuItemId: 'save-window' }, tabs[0] as never);
    await vi.advanceTimersByTimeAsync(2000);
    await handleMenuClick({ menuItemId: 'save-window' }, tabs[0] as never);
    await vi.advanceTimersByTimeAsync(1000); // first timer fires here
    expect(fb.badge.text).toBe('✓');
    await vi.advanceTimersByTimeAsync(BADGE_CLEAR_MS);
    expect(fb.badge.text).toBe('');
  });

  it('shows the check for the backup-now shortcut', async () => {
    await handleCommand('backup-now');
    expect(fb.badge.text).toBe('✓');
    expect(fb.badge.title).toBe('Saved to Backups: Full backup');
  });
});
