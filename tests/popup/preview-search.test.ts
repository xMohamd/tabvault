// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t, tp } from '@/lib/i18n';
import type { Backup, BackupTab, BookmarkNode } from '@/lib/schema';
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

function backup(withBookmarks = true): Backup {
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
    bookmarks: withBookmarks
      ? [
          {
            title: 'Bookmarks bar',
            folderType: 'bookmarks-bar',
            children: [
              { title: 'Docs bookmark', url: 'https://bm.example/docs' },
              { title: 'Reading', children: [{ title: 'Guide', url: 'https://bm.example/guide' }, { title: 'Tutorial docs', url: 'https://bm.example/tutorial' }] },
              { title: 'Unrelated folder', children: [{ title: 'Nothing', url: 'https://bm.example/nothing' }] },
            ],
          },
        ]
      : [],
  };
}

async function load(user: User, data: Backup = backup()) {
  await user.click(screen.getByRole('tab', { name: t('tabImport') }));
  const file = backupFile(data);
  await user.upload($<HTMLInputElement>('#import-file'), file);
  await screen.findByText(t('fileLoaded', file.name));
}
const search = (user: User, text: string) => user.type($('#preview-search'), text);
const rowNames = () => [...document.querySelectorAll('#preview-results [role=checkbox]')].map((el) => el.getAttribute('aria-label'));
const box = (name: string) => screen.getByRole('checkbox', { name });
const importButton = () => $<HTMLButtonElement>('#btn-import');
const urlsOf = (data: Backup) => data.windows.flatMap((w) => [...w.ungroupedTabs, ...w.groups.flatMap((g) => g.tabs)].map((x) => x.url));
const bookmarkUrls = (nodes: BookmarkNode[]): string[] => nodes.flatMap((n) => (n.url ? [n.url] : bookmarkUrls(n.children ?? [])));
const folderTitles = (nodes: BookmarkNode[]): string[] => nodes.flatMap((n) => (n.url ? [] : [n.title, ...folderTitles(n.children ?? [])]));
async function restore(user: User) {
  await user.click(importButton());
  await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
  return callsOf('IMPORT_START')[0] as { data: Backup; options: Record<string, unknown> };
}

beforeEach(() => {
  history.replaceState(null, '', '/?view=tab'); // file picking only works in the full-tab view
  installI18n();
  routeSend();
});
afterEach(resetEnvironment);

describe('search inside the loaded backup', () => {
  it('shows the search box above the tree', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);

    const input = $<HTMLInputElement>('#preview-search');
    expect(input.placeholder).toBe(t('previewSearchPlaceholder'));
    expect(input.getAttribute('aria-label')).toBe(t('previewSearchPlaceholder'));
    expect(has('#preview-tree')).toBe(true);
    expect(has('#preview-results')).toBe(false);
    expect(has('#btn-select-matching')).toBe(false); // replaced by per-result checkboxes
  });

  it('lists matching tabs and bookmarks with checkboxes, in place of the tree', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');

    expect(rowNames().sort()).toEqual(['Alpha docs', 'Docs bookmark', 'Docs for work', 'Tutorial docs']);
    expect($('#preview-match-count').textContent).toBe(tp('searchResultsCount', 4, '4'));
    expect(has('#preview-tree')).toBe(false);
    expect(screen.getByRole('radio', { name: t('searchFilterTabs', '2') })).toBeTruthy();
    expect(screen.getByRole('radio', { name: t('searchFilterBookmarks', '2') })).toBeTruthy();
    // The same rows as in the Backups search: group marker and folder path, no list of backups.
    const grouped = box('Docs for work').closest('li') as HTMLElement;
    expect(grouped.querySelector('.group-dot')?.getAttribute('data-color')).toBe('blue');
    expect((box('Tutorial docs').closest('li') as HTMLElement).textContent).toContain('Bookmarks bar / Reading');
    expect(grouped.querySelector('button:not([role=checkbox])')).toBeNull();
    // Nothing ticked yet: nothing to restore.
    expect(importButton().disabled).toBe(true);
    expect(importButton().textContent).toContain(t('searchSelectToRestore'));
    expect(has('#import-empty-hint')).toBe(false);
  });

  it('matches addresses too, case-insensitively, and needs every word', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'BOARD.example');
    expect(rowNames()).toEqual(['Board']);
    expect($('#preview-match-count').textContent).toBe(tp('searchResultsCount', 1, '1'));

    await user.clear($('#preview-search'));
    await search(user, 'docs work');
    expect(rowNames()).toEqual(['Docs for work']);
  });

  it('says so when nothing matches', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'zzz');

    expect($('#preview-empty').textContent).toContain(t('searchNoMatches'));
    expect($('#preview-empty').textContent).toContain(t('searchNoMatchesFileHint', 'zzz'));
    expect(has('#preview-results')).toBe(false);
    expect(importButton().disabled).toBe(true);
  });

  it('only searches bookmarks when the file has some (no filter for a single kind)', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user, backup(false));
    await search(user, 'docs');
    expect(rowNames().sort()).toEqual(['Alpha docs', 'Docs for work']);
    expect(has('#preview-filter')).toBe(false);
  });

  it('restores only the ticked tabs, with their groups', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click(box('Alpha docs'));
    await user.click(box('Docs for work'));

    expect(importButton().textContent).toContain(t('searchRestoreSelected', '2'));
    expect(importButton().disabled).toBe(false);
    const { data, options } = await restore(user);
    expect(urlsOf(data)).toEqual(['https://docs.example/a', 'https://docs.example/work']);
    expect(data.windows[0]?.groups).toHaveLength(1);
    expect(data.windows[0]?.groups[0]?.title).toBe('Work');
    expect(data.windows[0]?.groups[0]?.tabs).toHaveLength(1);
    expect(options).toMatchObject({ importTabs: true, importBookmarks: false });
    expect(bookmarkUrls(data.bookmarks)).toEqual([]);
  });

  it('drops groups that have no ticked tab', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'beta');
    await user.click(box('Beta'));
    const { data } = await restore(user);
    expect(urlsOf(data)).toEqual(['https://beta.example/']);
    expect(data.windows[0]?.groups).toEqual([]);
  });

  it('restores only the ticked bookmarks, keeping their folders and dropping empty ones', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click(box('Tutorial docs'));

    expect(importButton().textContent).toContain(t('searchRestoreSelected', '1'));
    const { data, options } = await restore(user);
    expect(options).toMatchObject({ importTabs: false, importBookmarks: true });
    expect(data.windows).toEqual([]);
    expect(bookmarkUrls(data.bookmarks)).toEqual(['https://bm.example/tutorial']);
    expect(folderTitles(data.bookmarks)).toEqual(['Bookmarks bar', 'Reading']); // "Unrelated folder" is gone
  });

  it('restores a mix of ticked tabs and bookmarks', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click(box('Alpha docs'));
    await user.click(box('Docs bookmark'));

    expect(importButton().textContent).toContain(t('searchRestoreSelected', '2'));
    const { data, options } = await restore(user);
    expect(options).toMatchObject({ importTabs: true, importBookmarks: true });
    expect(urlsOf(data)).toEqual(['https://docs.example/a']);
    expect(bookmarkUrls(data.bookmarks)).toEqual(['https://bm.example/docs']);
  });

  it('keeps the usual options: bookmark strategy and "open in" still apply', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click(box('Docs bookmark'));
    await user.click($('#bookmark-options > button'));
    await user.click(screen.getByRole('radio', { name: t('bmFolder') }));
    const { options } = await restore(user);
    expect(options).toMatchObject({ bookmarkStrategy: 'folder', importBookmarks: true });
  });

  it('selects all shown results, filters by kind, and clears the selection', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');

    await user.click(screen.getByRole('radio', { name: t('searchFilterTabs', '2') }));
    await user.click($('#btn-preview-select-all'));
    expect(importButton().textContent).toContain(t('searchRestoreSelected', '2'));
    await user.click(screen.getByRole('radio', { name: t('searchFilterAll', '4') }));
    expect(box('Docs bookmark').getAttribute('aria-checked')).toBe('false');
    await user.click($('#btn-preview-select-all'));
    expect(importButton().textContent).toContain(t('searchRestoreSelected', '4'));

    await user.click($('#btn-preview-clear'));
    expect(importButton().disabled).toBe(true);
    expect(importButton().textContent).toContain(t('searchSelectToRestore'));
  });

  it('keeps ticks while the query is refined', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click(box('Alpha docs'));
    // Replace the query without passing through an empty box: the earlier tick is no longer listed but still counts.
    fireEvent.change($('#preview-search'), { target: { value: 'beta' } });
    expect(rowNames()).toEqual(['Beta']);
    expect(importButton().textContent).toContain(t('searchRestoreSelected', '1'));
    await user.click(box('Beta'));
    expect(importButton().textContent).toContain(t('searchRestoreSelected', '2'));
  });

  it('clearing the search with Escape returns to the normal restore and drops the ticks', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click(box('Alpha docs'));
    await user.click($('#preview-search'));
    await user.keyboard('{Escape}');

    expect($<HTMLInputElement>('#preview-search').value).toBe('');
    expect(has('#preview-tree')).toBe(true);
    expect(has('#preview-results')).toBe(false);
    expect($('#preview-total').textContent).toBe(t('previewSelected', '5'));
    expect(importButton().textContent).toContain(t('importButtonBoth'));

    const { data, options } = await restore(user);
    expect(urlsOf(data)).toHaveLength(5);
    expect(options).toMatchObject({ importTabs: true, importBookmarks: true });
    expect(bookmarkUrls(data.bookmarks)).toHaveLength(4);
  });

  it('erasing the search text also clears the ticks', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click(box('Alpha docs'));
    await user.clear($('#preview-search'));
    expect(importButton().textContent).toContain(t('importButtonBoth'));
    await search(user, 'docs');
    expect(importButton().textContent).toContain(t('searchSelectToRestore'));
  });

  it('"What to restore" switches still apply: bookmarks off hides and ignores bookmark results', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await search(user, 'docs');
    await user.click(box('Alpha docs'));
    await user.click(box('Docs bookmark'));
    expect(importButton().textContent).toContain(t('searchRestoreSelected', '2'));

    await user.click($('#im-bookmarks'));
    expect(rowNames().sort()).toEqual(['Alpha docs', 'Docs for work']);
    expect(importButton().textContent).toContain(t('searchRestoreSelected', '1'));
    const { data, options } = await restore(user);
    expect(options).toMatchObject({ importTabs: true, importBookmarks: false });
    expect(urlsOf(data)).toEqual(['https://docs.example/a']);
  });

  it('tabs off hides tab results', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await user.click($('#im-tabs'));
    await search(user, 'docs');
    expect(rowNames().sort()).toEqual(['Docs bookmark', 'Tutorial docs']);
  });
});
