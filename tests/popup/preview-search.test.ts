// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t, tp } from '@/lib/i18n';
import type { Backup, BackupTab } from '@/lib/schema';
import { backupFile, callsOf, installI18n, renderApp, resetEnvironment, routeSend } from './helpers';

vi.mock('@/lib/messaging', () => ({ send: vi.fn() }));

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`No element matches ${selector}`);
  return el;
};
const has = (selector: string) => document.querySelector(selector) !== null;
type User = ReturnType<typeof userEvent.setup>;

const tab = (title: string, url: string): BackupTab => ({ title, url, pinned: false });

function backup(): Backup {
  return {
    schemaVersion: '1.1',
    exportedAt: '2025-01-15T10:00:00.000Z',
    source: {},
    windows: [
      {
        ungroupedTabs: [tab('Alpha docs', 'https://docs.example/a'), tab('Beta', 'https://beta.example/')],
        groups: [
          {
            title: 'Work',
            color: 'blue',
            collapsed: false,
            tabs: [
              tab('Board', 'https://board.example/'),
              tab('Docs for work', 'https://docs.example/work'),
              tab('Other', 'https://o.example/'),
            ],
          },
        ],
      },
    ],
    bookmarks: [],
  };
}

async function load(user: User) {
  await user.click(screen.getByRole('tab', { name: t('tabImport') }));
  const file = backupFile(backup());
  await user.upload($<HTMLInputElement>('#import-file'), file);
  await screen.findByText(t('fileLoaded', file.name));
}
const search = (user: User, text: string) => user.type($('#preview-search'), text);
const resultTitles = () => [...document.querySelectorAll('#preview-results > li')].map((li) => li.firstElementChild?.textContent);
const urlsOf = (data: Backup) =>
  data.windows.flatMap((w) => [...w.ungroupedTabs, ...w.groups.flatMap((g) => g.tabs)].map((x) => x.url));

beforeEach(() => {
  history.replaceState(null, '', '/?view=tab'); // file picking only works in the full-tab view
  installI18n();
  routeSend();
});
afterEach(resetEnvironment);

describe('search inside a backup', () => {
  it('shows the search box above the tree', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);

    const input = $<HTMLInputElement>('#preview-search');
    expect(input.placeholder).toBe(t('previewSearchPlaceholder'));
    expect(input.getAttribute('aria-label')).toBe(t('previewSearchPlaceholder'));
    expect(has('#preview-tree')).toBe(true);
    expect(has('#preview-results')).toBe(false);
  });

  it('lists the matching tabs with their count, in place of the tree', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');

    expect(resultTitles()).toEqual(['Alpha docs', 'Docs for work']);
    expect($('#preview-match-count').textContent).toBe(tp('previewMatchCount', 2, '2'));
    expect(has('#preview-tree')).toBe(false);
    // The scrollable results list is keyboard-reachable and named (axe: scrollable-region-focusable).
    expect($('#preview-results').getAttribute('tabindex')).toBe('0');
    expect($('#preview-results').getAttribute('aria-label')).toBe(t('previewResultsLabel'));
  });

  it('matches addresses too, case-insensitively, and needs every word', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'BOARD.example');
    expect(resultTitles()).toEqual(['Board']);
    expect($('#preview-match-count').textContent).toBe(tp('previewMatchCount', 1, '1'));

    await user.clear($('#preview-search'));
    await search(user, 'docs work');
    expect(resultTitles()).toEqual(['Docs for work']);
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'zzz');

    expect($('#preview-match-count').textContent).toBe(t('previewNoMatches'));
    expect(has('#preview-results')).toBe(false);
    expect($('#btn-select-matching').hasAttribute('disabled')).toBe(true);
  });

  it('"Select only matching" restores just those tabs, keeping their groups', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click($('#btn-select-matching'));

    expect($('#preview-total').textContent).toBe(tp('previewRestoringMatching', 2, '2'));
    expect($('#btn-import').textContent).toContain(tp('importButtonTabs', 2, '2'));

    await user.click($('#btn-import'));
    await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
    const data = callsOf('IMPORT_START')[0]?.data as Backup;
    expect(urlsOf(data)).toEqual(['https://docs.example/a', 'https://docs.example/work']);
    expect(data.windows[0]?.groups).toHaveLength(1);
    expect(data.windows[0]?.groups[0]?.title).toBe('Work');
    expect(data.windows[0]?.groups[0]?.tabs).toHaveLength(1);
  });

  it('drops groups that have no matching tab', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'beta');
    await user.click($('#btn-select-matching'));
    await user.click($('#btn-import'));

    await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
    const data = callsOf('IMPORT_START')[0]?.data as Backup;
    expect(urlsOf(data)).toEqual(['https://beta.example/']);
    expect(data.windows[0]?.groups).toEqual([]);
  });

  it('"Clear" empties the search and brings the full selection back', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click($('#btn-select-matching'));
    await user.click($('#btn-clear-search'));

    expect($<HTMLInputElement>('#preview-search').value).toBe('');
    expect(has('#preview-tree')).toBe(true);
    expect($('#preview-total').textContent).toBe(t('previewSelected', '5'));
    expect($('#btn-import').textContent).toContain(tp('importButtonTabs', 5, '5'));

    await user.click($('#btn-import'));
    await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
    expect(urlsOf(callsOf('IMPORT_START')[0]?.data as Backup)).toHaveLength(5);
  });

  it('keeps the filter after the search text is erased, until cleared', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click($('#btn-select-matching'));
    await user.clear($('#preview-search'));

    expect(has('#preview-tree')).toBe(true);
    expect($('#preview-total').textContent).toBe(tp('previewRestoringMatching', 2, '2'));
    expect(has('#btn-clear-search')).toBe(true);
  });

  it('a manual tick replaces the filter and keeps the tick', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click($('#btn-select-matching'));
    await user.click($('#btn-select-none'));

    expect($('#preview-total').textContent).toBe(t('previewSelected', '0'));
    await user.click($('#btn-select-all'));
    await user.click($('#btn-import'));
    await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
    expect(urlsOf(callsOf('IMPORT_START')[0]?.data as Backup)).toHaveLength(5);
  });
});
