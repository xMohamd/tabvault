/**
 * Shared test setup for the popup component tests.
 *
 * The tests files are `.test.ts` (the vitest include pattern), so they build
 * elements with createElement instead of JSX.
 */
import { vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { send } from '@/lib/messaging';
import { _resetI18nCache } from '@/lib/i18n';
import messages from '../../public/_locales/en/messages.json';
import { App } from '../../src/entrypoints/popup/App';
import type { Backup } from '@/lib/schema';
import type { ImportState } from '@/lib/types';

type MessageTable = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;

/** browser.i18n backed by the real messages.json, with Chrome's placeholder semantics. */
export function installI18n(table: MessageTable = messages as MessageTable): void {
  const getMessage = (key: string, substitutions?: string | string[]): string => {
    const entry = table[key];
    if (!entry) return '';
    const subs = substitutions === undefined ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
    let text = entry.message;
    for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
      const index = Number(/\$(\d)/.exec(placeholder.content)?.[1] ?? 0);
      text = text.replace(new RegExp(`\\$${name}\\$`, 'gi'), subs[index - 1] ?? '');
    }
    return text.replace(/\$\$/g, '$');
  };
  (browser as unknown as { i18n: unknown }).i18n = { getMessage, getUILanguage: () => 'en' };
  _resetI18nCache();
}

export const CHROME_INFO = {
  key: 'chrome',
  name: 'Chrome',
  family: 'chromium',
  features: {
    tabGroups: true,
    groupColors: true,
    groupCollapse: true,
    bookmarks: true,
    downloads: true,
    discard: true,
    discardOnCreate: false,
    alarms: true,
    sessionStorage: true,
  },
} as const;

export const IDLE_STATE: ImportState = { status: 'idle', current: 0, total: 0, message: '' };

export const DEFAULT_SETTINGS = { enabled: false, frequency: 'daily', keep: 7, includeBookmarks: true } as const;

type Handler = (payload: Record<string, unknown>) => unknown;

/** Routes `send(type, payload)` to per-type handlers; unknown types get a benign default. */
export function routeSend(handlers: Record<string, Handler> = {}) {
  const sendMock = vi.mocked(send);
  const defaults: Record<string, Handler> = {
    GET_STATE: () => ({ ok: true, browser: CHROME_INFO, importState: IDLE_STATE }),
    EXPORT_PREVIEW: () => ({ ok: true, stats: { windows: 2, tabs: 7, groups: 1, bookmarks: 12, bookmarklets: 1, skippedTabs: 0 } }),
    SNAPSHOTS_LIST: () => ({ ok: true, snapshots: [], settings: DEFAULT_SETTINGS, lastRun: null }),
    IMPORT_START: () => ({ ok: true }),
    IMPORT_CANCEL: () => ({ ok: true }),
    SNAPSHOT_DELETE: () => ({ ok: true }),
  };
  sendMock.mockReset();
  sendMock.mockImplementation((async (type: string, payload: Record<string, unknown> = {}) => {
    const handler = handlers[type] ?? defaults[type];
    return handler ? handler(payload) : { ok: false, error: `unhandled ${type}` };
  }) as never);
  return sendMock;
}

/** Calls of one message type, as [payload, ...]. */
export const callsOf = (type: string) =>
  vi
    .mocked(send)
    .mock.calls.filter(([t]) => t === type)
    .map(([, payload]) => payload as Record<string, any>);

export function renderApp() {
  return render(createElement(App));
}

export function resetEnvironment(): void {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.classList.remove('is-tab-view');
  history.replaceState(null, '', '/');
  location.hash = '';
}

/** Delivers a background broadcast to every registered runtime.onMessage listener. */
export function broadcast(message: unknown): void {
  (fakeBrowser.runtime.onMessage as unknown as { trigger(message: unknown): void }).trigger(message);
}

const tab = (url: string) => ({ url, title: url, pinned: false });

export function makeBackup(withBookmarks = false): Backup {
  return {
    schemaVersion: '1.1',
    exportedAt: '2025-01-15T10:00:00.000Z',
    source: {},
    windows: [
      {
        ungroupedTabs: [tab('https://a.example/'), tab('https://b.example/')],
        groups: [
          {
            title: 'Work',
            color: 'blue',
            collapsed: false,
            tabs: [tab('https://c.example/'), tab('https://d.example/'), tab('https://e.example/')],
          },
        ],
      },
    ],
    bookmarks: withBookmarks
      ? [{ title: 'Bookmarks bar', children: [{ title: 'Example', url: 'https://example.com/' }] }]
      : [],
  };
}

export function backupFile(backup: Backup = makeBackup(), name = 'backup.json'): File {
  return new File([JSON.stringify(backup)], name, { type: 'application/json' });
}
