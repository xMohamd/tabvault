// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t, tp } from '@/lib/i18n';
import { emptyBackup, type Backup, type BackupTab } from '@/lib/schema';
import { searchBackups } from '@/lib/snapshot-search';
import { backupFile, callsOf, installI18n, renderApp, resetEnvironment, routeSend } from './helpers';

vi.mock('@/lib/messaging', () => ({ send: vi.fn() }));

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`No element matches ${selector}`);
  return el;
};
const has = (selector: string) => document.querySelector(selector) !== null;
type User = ReturnType<typeof userEvent.setup>;

const tab = (title: string, url: string, extra: Partial<BackupTab> = {}): BackupTab => ({ title, url, pinned: false, ...extra });

const OLD = '2025-01-10T10:00:00.000Z';
const NEW = '2025-02-20T10:00:00.000Z';

function snapshotData(variant: 'old' | 'new'): Backup {
  const data = emptyBackup();
  data.windows.push({
    ungroupedTabs: [tab('Pinned wiki', 'https://wiki.example/', { pinned: true }), tab('Plain wiki page', 'https://wiki.example/page')],
    groups:
      variant === 'new'
        ? [{ title: 'Research', color: 'green', collapsed: false, tabs: [tab('Wiki notes', 'https://notes.example/wiki')] }]
        : [],
  });
  data.bookmarks = [{ title: 'Bookmarks bar', children: [{ title: 'Wiki bookmark', url: 'https://bm.example/wiki' }] }];
  return data;
}

const sources = [
  { id: 'new', label: 'Manual · Feb 20', date: NEW, data: snapshotData('new') },
  { id: 'old', label: 'Scheduled · Jan 10', date: OLD, data: snapshotData('old') },
];

/** Answers SEARCH_SNAPSHOTS with the real search over the fixture snapshots. */
const searchRoute = () => ({
  SNAPSHOTS_LIST: () => ({ ok: true, snapshots: [], settings: { enabled: false, frequency: 'daily', keep: 7, includeBookmarks: true }, lastRun: null }),
  SEARCH_SNAPSHOTS: (p: Record<string, unknown>) => ({ ok: true, ...searchBackups(sources, String(p.query), { limit: Number(p.limit) }), searched: sources.length }),
});

async function openBackups(user: User) {
  await user.click(screen.getByRole('tab', { name: t('tabBackups') }));
  await waitFor(() => expect(has('#backups-panel')).toBe(true));
}
const searchFor = (user: User, text: string) => user.type($('#backups-search'), text);
const rowNames = () => [...document.querySelectorAll('#search-results [role=checkbox]')].map((el) => el.getAttribute('aria-label'));
const checkbox = (name: string) => screen.getByRole('checkbox', { name });
const restoreButton = () => $<HTMLButtonElement>('#btn-restore-selected');

beforeEach(() => {
  history.replaceState(null, '', '/?view=tab');
  installI18n();
  routeSend(searchRoute());
});
afterEach(resetEnvironment);

describe('search across backups', () => {
  it('searches through SEARCH_SNAPSHOTS after a pause and replaces the snapshot list', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    expect(has('#snapshots-heading')).toBe(true);
    expect($<HTMLInputElement>('#backups-search').type).toBe('search');
    expect($('#backups-search').getAttribute('aria-label')).toBe(t('searchBackupsLabel'));

    await searchFor(user, 'wiki');
    expect(callsOf('SEARCH_SNAPSHOTS')).toHaveLength(0); // debounced: nothing sent while typing
    await waitFor(() => expect(has('#search-results')).toBe(true));
    // One call, for the whole word: not one per keystroke.
    expect(callsOf('SEARCH_SNAPSHOTS')).toEqual([{ query: 'wiki', limit: 500 }]);
    expect(has('#snapshots-heading')).toBe(false);
    expect(has('#backups-auto')).toBe(false);

    // 4 distinct pages: the pinned and plain tabs and the note tab are in the newest snapshot, and the bookmark.
    expect(rowNames()).toHaveLength(4);
    expect($('#search-summary').textContent).toBe(`${tp('searchResultsCount', 4, '4')} in ${tp('searchBackupsCount', 2, '2')}`);
    expect(has('#btn-restore-selected')).toBe(true);
    expect(restoreButton().disabled).toBe(true);
  });

  it('shows where a page was found: backup count, newest date, group and folder', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await searchFor(user, 'wiki');
    await waitFor(() => expect(has('#search-results')).toBe(true));

    const plain = checkbox('Plain wiki page').closest('li') as HTMLElement;
    expect(plain.textContent).toContain('https://wiki.example/page');
    expect(plain.textContent).toMatch(/in 2 backups/);
    expect(plain.querySelector('button:not([role=checkbox])')?.getAttribute('aria-label')).toEqual(expect.stringMatching(/^in 2 backups.*: Manual · Feb 20; Scheduled · Jan 10$/));
    const grouped = checkbox('Wiki notes').closest('li') as HTMLElement;
    expect(grouped.textContent).toContain('Research');
    expect(grouped.querySelector('.group-dot')?.getAttribute('data-color')).toBe('green');
    expect(grouped.textContent).toMatch(/in 1 backup /);
    expect((checkbox('Wiki bookmark').closest('li') as HTMLElement).textContent).toContain('Bookmarks bar');
  });

  it('filters by kind with counts and keeps the summary', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await searchFor(user, 'wiki');
    await waitFor(() => expect(has('#search-results')).toBe(true));

    expect(screen.getByRole('radio', { name: t('searchFilterAll', '4') })).toBeTruthy();
    await user.click(screen.getByRole('radio', { name: t('searchFilterBookmarks', '1') }));
    expect(rowNames()).toEqual(['Wiki bookmark']);
    await user.click(screen.getByRole('radio', { name: t('searchFilterTabs', '3') }));
    expect(rowNames()).toHaveLength(3);
    expect(rowNames()).not.toContain('Wiki bookmark');
  });

  it('selects rows, selects all visible and clears', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await searchFor(user, 'wiki');
    await waitFor(() => expect(has('#search-results')).toBe(true));

    await user.click(checkbox('Plain wiki page'));
    expect(restoreButton().textContent).toContain(t('searchRestoreSelected', '1'));
    expect(restoreButton().disabled).toBe(false);

    await user.click(screen.getByRole('radio', { name: t('searchFilterTabs', '3') }));
    await user.click($('#btn-search-select-all'));
    expect(restoreButton().textContent).toContain(t('searchRestoreSelected', '3'));
    await user.click(screen.getByRole('radio', { name: t('searchFilterAll', '4') }));
    expect(checkbox('Wiki bookmark').getAttribute('aria-checked')).toBe('false');

    await user.click($('#btn-search-clear'));
    expect(restoreButton().disabled).toBe(true);
    expect(restoreButton().textContent).toContain(t('searchSelectToRestore'));
  });

  it('says so when nothing matches, and reports a failed search', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await searchFor(user, 'zzzz');
    await waitFor(() => expect(has('#search-empty')).toBe(true));
    expect($('#search-empty').textContent).toContain(t('searchNoMatches'));
    expect(restoreButton().disabled).toBe(true);

    routeSend({ ...searchRoute(), SEARCH_SNAPSHOTS: () => ({ ok: false, error: 'boom' }) });
    await user.type($('#backups-search'), 'x');
    await waitFor(() => expect(has('#search-error')).toBe(true));
    expect($('#search-error').textContent).toBe(t('searchFailed', 'boom'));
  });

  it('Escape clears the search and brings the snapshot list back', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await searchFor(user, 'wiki');
    await waitFor(() => expect(has('#search-results')).toBe(true));

    await user.keyboard('{Escape}');
    expect($<HTMLInputElement>('#backups-search').value).toBe('');
    await waitFor(() => expect(has('#search-results')).toBe(false));
    expect(has('#snapshots-heading')).toBe(true);
    expect(has('#btn-backup-now')).toBe(true);
  });

  it('loads the ticked results into the Import tab: tabs in one window, groups recreated, bookmarks in a folder', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await searchFor(user, 'wiki');
    await waitFor(() => expect(has('#search-results')).toBe(true));

    await user.click($('#btn-search-select-all'));
    expect(restoreButton().textContent).toContain(t('searchRestoreSelected', '4'));
    await user.click(restoreButton());

    // Now in the Import tab with the normal summary and options.
    await waitFor(() => expect(has('#import-summary')).toBe(true));
    expect($('#summary-format').textContent).toContain(t('formatSearchResults'));
    expect($('#summary-stats').textContent).toBe(`3${t('labelTabs')}1${t('labelWindows')}1${t('labelGroups')}1${t('labelBookmarks')}`);
    expect($('#file-info').textContent).toBe(tp('fileLoadedSearch', 4, '4'));
    expect(has('#tab-options')).toBe(true); // the usual restore options

    await user.click($('#btn-import'));
    await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
    const { data } = callsOf('IMPORT_START')[0] as { data: Backup };
    expect(data.windows).toHaveLength(1);
    const win = data.windows[0]!;
    expect(win.ungroupedTabs.map((x) => [x.url, x.pinned])).toEqual(
      expect.arrayContaining([['https://wiki.example/', true], ['https://wiki.example/page', false]]),
    );
    expect(win.groups.map((g) => [g.title, g.color, g.tabs.map((x) => x.url)])).toEqual([['Research', 'green', ['https://notes.example/wiki']]]);
    expect(data.bookmarks).toEqual([{ title: t('searchBookmarksFolder'), children: [{ title: 'Wiki bookmark', url: 'https://bm.example/wiki' }] }]);
  });

  it('keeps ticks while the query is refined', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await searchFor(user, 'wiki');
    await waitFor(() => expect(has('#search-results')).toBe(true));
    await user.click(checkbox('Plain wiki page'));
    await user.type($('#backups-search'), ' notes');
    await waitFor(() => expect(rowNames()).toEqual(['Wiki notes']));
    await user.click(checkbox('Wiki notes'));
    expect(restoreButton().textContent).toContain(t('searchRestoreSelected', '2'));
  });

  it('also searches the file loaded in the Import tab and merges it with the snapshots', async () => {
    const user = userEvent.setup();
    renderApp();
    const file = emptyBackup();
    file.exportedAt = '2025-03-01T10:00:00.000Z';
    file.windows.push({
      ungroupedTabs: [tab('Plain wiki page', 'https://wiki.example/page'), tab('Only in file wiki', 'https://file.example/wiki')],
      groups: [],
    });
    await user.click(screen.getByRole('tab', { name: t('tabImport') }));
    await user.upload($<HTMLInputElement>('#import-file'), backupFile(file, 'mine.json'));
    await screen.findByText(t('fileLoaded', 'mine.json'));

    await openBackups(user);
    await searchFor(user, 'wiki');
    await waitFor(() => expect(has('#search-results')).toBe(true));

    // The file adds one new page and a third source to a page the snapshots already had.
    expect(rowNames()).toHaveLength(5);
    expect($('#search-summary').textContent).toBe(`${tp('searchResultsCount', 5, '5')} in ${tp('searchBackupsCount', 3, '3')}`);
    const shared = checkbox('Plain wiki page').closest('li') as HTMLElement;
    expect(shared.textContent).toMatch(/in 3 backups/);
    expect(shared.querySelector('button:not([role=checkbox])')?.getAttribute('aria-label')).toContain(t('searchLoadedFile', 'mine.json'));
    expect((checkbox('Only in file wiki').closest('li') as HTMLElement).querySelector('button:not([role=checkbox])')?.getAttribute('aria-label')).toEqual(
      expect.stringContaining(`: ${t('searchLoadedFile', 'mine.json')}`),
    );
  });
});
