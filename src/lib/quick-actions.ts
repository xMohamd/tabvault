/**
 * Right-click menu and keyboard shortcuts that save a window or a tab group as a snapshot
 * without opening the popup.
 *
 * Feedback uses the toolbar button only (badge + tooltip), so no extra permission is needed:
 * a teal check on success, a red "!" on failure, both cleared after a moment.
 *
 * Decision: "Save this tab group" on a tab that is not in a group saves the whole window
 * instead (the tooltip says so) rather than failing, because the user clearly wants this
 * tab's surroundings kept.
 */
import { browser, type Browser } from 'wxt/browser';
import { detectBrowserAsync } from './browser-detect';
import { createSnapshot } from './backup-scheduler';
import { t } from './i18n';
import { logger } from './logger';

export const MENU_SAVE_WINDOW = 'save-window';
export const MENU_SAVE_GROUP = 'save-group';
export const COMMAND_BACKUP_NOW = 'backup-now';
export const COMMAND_SAVE_WINDOW = 'save-window';

export const BADGE_OK_COLOR = '#0f766e';
export const BADGE_ERROR_COLOR = '#b91c1c';
export const BADGE_OK_TEXT = '✓';
export const BADGE_ERROR_TEXT = '!';
export const BADGE_CLEAR_MS = 2500;
const TITLE_MAX = 60;
const NO_GROUP = -1;

type Tab = Browser.tabs.Tab;

/** Truncates to `max` characters, with an ellipsis. */
function shorten(text: string, max = TITLE_MAX): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---------- feedback ----------

let feedbackId = 0;

/** Shows the outcome on the toolbar button, then restores it. Never throws. */
async function flash(ok: boolean, tooltip: string): Promise<void> {
  const action = browser.action as typeof browser.action | undefined;
  if (!action) return;
  const mine = ++feedbackId;
  try {
    await action.setBadgeBackgroundColor({ color: ok ? BADGE_OK_COLOR : BADGE_ERROR_COLOR });
    await action.setBadgeText({ text: ok ? BADGE_OK_TEXT : BADGE_ERROR_TEXT });
    await action.setTitle({ title: tooltip });
  } catch (error) {
    logger.warn('QUICK_FEEDBACK_FAILED', {}, error);
    return;
  }
  setTimeout(() => {
    // A newer outcome owns the button now.
    if (mine !== feedbackId) return;
    void (async () => {
      try {
        await action.setBadgeText({ text: '' });
        await action.setTitle({ title: t('extActionTitle') });
      } catch {
        // The worker may be shutting down: nothing to restore.
      }
    })();
  }, BADGE_CLEAR_MS);
}

// ---------- targets ----------

async function activeTitle(windowId: number): Promise<string> {
  // Filter again: the query is already scoped by the browser, this keeps odd implementations honest.
  const tabs = await browser.tabs.query({ active: true, windowId });
  return tabs.find((tab) => tab.active && tab.windowId === windowId)?.title?.trim() ?? '';
}

/** The window the user means: the clicked tab's, else the last focused normal window. */
async function resolveWindowId(tab?: Tab): Promise<number> {
  if (typeof tab?.windowId === 'number' && tab.windowId >= 0) return tab.windowId;
  const win = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
  if (typeof win.id !== 'number') throw new Error(t('quickNoWindow'));
  return win.id;
}

async function windowTitle(windowId: number): Promise<string> {
  const title = shorten(await activeTitle(windowId));
  return t('quickWindowTitle', title || t('quickWindowFallback'));
}

/** The clicked tab if given, else the active tab of the target window. */
async function resolveTab(tab?: Tab): Promise<Tab | undefined> {
  if (tab && typeof tab.windowId === 'number') return tab;
  const windowId = await resolveWindowId(tab);
  const tabs = await browser.tabs.query({ active: true, windowId });
  return tabs.find((candidate) => candidate.active && candidate.windowId === windowId);
}

async function groupTitle(windowId: number, groupId: number): Promise<string> {
  try {
    const groups = await browser.tabGroups.query({ windowId });
    return groups.find((group) => group.id === groupId)?.title?.trim() ?? '';
  } catch {
    return '';
  }
}

// ---------- actions ----------

/** Saves the window of `tab` (or the focused window) as a quick snapshot. */
export async function quickSaveWindow(tab?: Tab): Promise<void> {
  try {
    const windowId = await resolveWindowId(tab);
    const title = await windowTitle(windowId);
    await createSnapshot('quick', {
      browser: await detectBrowserAsync(),
      includeBookmarks: false,
      scope: { windowId, title },
    });
    logger.info('QUICK_SAVE_WINDOW', { windowId });
    await flash(true, t('quickSavedTip', title));
  } catch (error) {
    await failed('QUICK_SAVE_WINDOW_FAILED', error);
  }
}

/** Saves the tab group of `tab` (or the active tab); falls back to the window when it has none. */
export async function quickSaveGroup(tab?: Tab): Promise<void> {
  try {
    const target = await resolveTab(tab);
    const groupId = target?.groupId;
    if (!target || typeof groupId !== 'number' || groupId === NO_GROUP) {
      const windowId = await resolveWindowId(target ?? tab);
      const title = await windowTitle(windowId);
      await createSnapshot('quick', {
        browser: await detectBrowserAsync(),
        includeBookmarks: false,
        scope: { windowId, title },
      });
      logger.info('QUICK_SAVE_GROUP_FALLBACK_WINDOW', { windowId });
      await flash(true, t('quickSavedWindowInsteadTip', title));
      return;
    }
    const title = shorten(await groupTitle(target.windowId, groupId)) || t('previewUntitledGroup');
    await createSnapshot('quick', {
      browser: await detectBrowserAsync(),
      includeBookmarks: false,
      scope: { groupId, title },
    });
    logger.info('QUICK_SAVE_GROUP', { groupId });
    await flash(true, t('quickSavedTip', title));
  } catch (error) {
    await failed('QUICK_SAVE_GROUP_FAILED', error);
  }
}

/** Saves everything (windows and tabs, no bookmarks) like the popup's Back up now. */
export async function backupNow(): Promise<void> {
  try {
    await createSnapshot('manual', { browser: await detectBrowserAsync() });
    logger.info('QUICK_BACKUP_NOW');
    await flash(true, t('quickSavedTip', t('quickBackupNowTitle')));
  } catch (error) {
    await failed('QUICK_BACKUP_NOW_FAILED', error);
  }
}

async function failed(action: string, error: unknown): Promise<void> {
  logger.error(action, {}, error);
  await flash(false, t('quickFailedTip', errorText(error)));
}

export async function handleMenuClick(
  info: { menuItemId: string | number },
  tab?: Tab,
): Promise<void> {
  if (info.menuItemId === MENU_SAVE_WINDOW) await quickSaveWindow(tab);
  else if (info.menuItemId === MENU_SAVE_GROUP) await quickSaveGroup(tab);
}

export async function handleCommand(command: string, tab?: Tab): Promise<void> {
  if (command === COMMAND_BACKUP_NOW) await backupNow();
  else if (command === COMMAND_SAVE_WINDOW) await quickSaveWindow(tab);
}

// ---------- menus ----------

/** Recreates both menu items. Titles come from i18n, so they are rebuilt on every install/update. */
export async function createMenus(): Promise<void> {
  const menus = browser.contextMenus as typeof browser.contextMenus | undefined;
  if (!menus) return;
  await menus.removeAll();
  const info = await detectBrowserAsync();
  const items: Array<[string, string]> = [
    [MENU_SAVE_WINDOW, t('quickMenuSaveWindow')],
    [MENU_SAVE_GROUP, t('quickMenuSaveGroup')],
  ];
  for (const [id, title] of items) {
    const base = ['action', 'page'] as const;
    const create = (contexts: readonly string[]) =>
      menus.create({ id, title, contexts: [...contexts] } as Browser.contextMenus.CreateProperties);
    if (info.key === 'firefox') {
      // The tab strip context is Firefox-only; tolerate versions without it.
      try {
        create([...base, 'tab']);
        continue;
      } catch {
        // Fall through to the common contexts.
      }
    }
    create(base);
  }
}

/** Wires the menu, the keyboard shortcuts and the install-time menu setup. Call once from the background. */
export function registerQuickActions(): void {
  browser.runtime.onInstalled.addListener(() => {
    void createMenus().catch((error: unknown) => logger.warn('MENU_SETUP_FAILED', {}, error));
  });
  (browser.contextMenus as typeof browser.contextMenus | undefined)?.onClicked.addListener((info, tab) => {
    void handleMenuClick(info, tab);
  });
  (browser.commands as typeof browser.commands | undefined)?.onCommand.addListener((command, tab) => {
    void handleCommand(command, tab);
  });
}
