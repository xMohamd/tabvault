// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t, tp } from '@/lib/i18n';
import { emptyBackup, type Backup, type BackupTab } from '@/lib/schema';
import { searchBackups } from '@/lib/snapshot-search';
import { dateTimeFormat } from '../../src/entrypoints/popup/shared';
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

const meta = (id: string, createdAt: string, reason: string, tabs: number) => ({
  id,
  createdAt,
  reason,
  stats: { windows: 1, tabs, groups: 0, bookmarks: 1, skippedTabs: 0 },
  bytes: 2048,
  hash: id,
});
const METAS = [meta('old', OLD, 'scheduled', 2), meta('new', NEW, 'manual', 3)]; // stored out of order on purpose
const dateOf = (iso: string) => dateTimeFormat.format(new Date(iso));

/** Answers SEARCH_SNAPSHOTS with the real search over the fixture snapshots (only `ids`, when given). */
const searchRoute = (list: () => unknown[] = () => METAS) => ({
  SNAPSHOTS_LIST: () => ({ ok: true, snapshots: list(), settings: { enabled: false, frequency: 'daily', keep: 7, includeBookmarks: true }, lastRun: null }),
  SEARCH_SNAPSHOTS: (p: Record<string, unknown>) => {
    const ids = p.ids as string[] | undefined;
    const used = ids ? sources.filter((s) => ids.includes(s.id)) : sources;
    return { ok: true, ...searchBackups(used, String(p.query), { limit: Number(p.limit) }), searched: used.length, available: sources.length };
  },
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
    expect($('#search-summary').textContent).toBe(t('searchSummaryAll', [tp('searchResultsCount', 4, '4'), '2']));
    expect($('#search-summary').textContent).toBe('4 results in all 2 backups');
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
    expect($('#search-summary').textContent).toBe('5 results in all 3 backups'); // the file counts as a backup
    const shared = checkbox('Plain wiki page').closest('li') as HTMLElement;
    expect(shared.textContent).toMatch(/in 3 backups/);
    expect(shared.querySelector('button:not([role=checkbox])')?.getAttribute('aria-label')).toContain(t('searchLoadedFile', 'mine.json'));
    expect((checkbox('Only in file wiki').closest('li') as HTMLElement).querySelector('button:not([role=checkbox])')?.getAttribute('aria-label')).toEqual(
      expect.stringContaining(`: ${t('searchLoadedFile', 'mine.json')}`),
    );
  });
});

describe('choosing which backups to search', () => {
  const scopeButton = () => $<HTMLButtonElement>('#search-scope');
  const openScope = (user: User) => user.click(scopeButton());
  const item = (id: string) => $(id === 'scope-file' ? '#scope-file' : `[data-scope-id="${id}"]`);
  const itemIds = () => [...document.querySelectorAll('[role=menuitemcheckbox]')].map((el) => el.getAttribute('data-scope-id') ?? el.id);
  const checked = (el: Element) => el.getAttribute('aria-checked');
  const lastSearch = () => callsOf('SEARCH_SNAPSHOTS').at(-1);
  const searched = (user: User, text = 'wiki') => searchFor(user, text).then(() => waitFor(() => expect(has('#search-results')).toBe(true)));
  async function loadFile(user: User) {
    const file = emptyBackup();
    file.exportedAt = '2025-03-01T10:00:00.000Z';
    file.windows.push({ ungroupedTabs: [tab('Plain wiki page', 'https://wiki.example/page'), tab('Only in file wiki', 'https://file.example/wiki')], groups: [] });
    await user.click(screen.getByRole('tab', { name: t('tabImport') }));
    await user.upload($<HTMLInputElement>('#import-file'), backupFile(file, 'mine.json'));
    await screen.findByText(t('fileLoaded', 'mine.json'));
  }

  it('defaults to all backups; the menu lists them newest first, each with date, kind and tab count', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);

    expect(scopeButton().textContent).toBe(t('searchScopeAll'));
    expect(scopeButton().getAttribute('aria-label')).toBe(t('searchScopeButtonLabel', t('searchScopeAll')));
    await openScope(user);
    expect(itemIds()).toEqual(['scope-all', 'new', 'old']);
    expect([...document.querySelectorAll('[role=menuitemcheckbox]')].every((el) => checked(el) === 'true')).toBe(true);
    expect(item('new').textContent).toContain(dateOf(NEW));
    expect(item('new').textContent).toContain(`${t('reasonManual')} · 3 ${t('labelTabs').toLowerCase()}`);
    expect(item('old').textContent).toContain(`${t('reasonScheduled')} · 2 ${t('labelTabs').toLowerCase()}`);
  });

  it('searches only the ticked backups, keeps the menu open and counts them in the summary', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await openScope(user);
    await user.click(item('new')); // untick

    expect(has('[role=menu]')).toBe(true); // stays open while toggling
    expect(checked(item('new'))).toBe('false');
    expect(checked($('#scope-all'))).toBe('false');
    expect(scopeButton().textContent).toBe(t('searchScopeSome', ['1', '2']));
    await user.keyboard('{Escape}');

    await searched(user);
    expect(callsOf('SEARCH_SNAPSHOTS')).toEqual([{ query: 'wiki', limit: 500, ids: ['old'] }]);
    expect(rowNames()).toHaveLength(3); // the old snapshot has no "Wiki notes" tab
    expect($('#search-summary').textContent).toBe(t('searchSummaryPart', [tp('searchResultsCount', 3, '3'), '1', '2']));
    expect($('#search-summary').textContent).toBe('3 results in 1 of 2 backups');
  });

  it('never lets the last backup be unticked', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await openScope(user);
    expect(document.body.textContent).not.toContain(t('searchScopeLastHint'));
    await user.click(item('new'));

    expect(item('old').getAttribute('aria-disabled')).toBe('true');
    expect(checked(item('old'))).toBe('true');
    expect(document.body.textContent).toContain(t('searchScopeLastHint'));
    await user.click(item('old')); // ignored
    expect(scopeButton().textContent).toBe(t('searchScopeSome', ['1', '2']));
  });

  it('"All backups" ticks everything; unticking it leaves only the newest backup', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await openScope(user);
    await user.click(item('new'));
    expect(scopeButton().textContent).toBe(t('searchScopeSome', ['1', '2']));

    await user.click($('#scope-all'));
    expect(scopeButton().textContent).toBe(t('searchScopeAll'));
    expect(checked(item('new'))).toBe('true');
    expect(checked(item('old'))).toBe('true');

    await user.click($('#scope-all'));
    expect(checked($('#scope-all'))).toBe('false');
    expect(checked(item('new'))).toBe('true');
    expect(checked(item('old'))).toBe('false');
    expect(scopeButton().textContent).toBe(t('searchScopeSome', ['1', '2']));
  });

  it('searches again when the scope changes while results are showing', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await searched(user);
    expect(rowNames()).toHaveLength(4);

    await openScope(user);
    await user.click(item('old'));
    await waitFor(() => expect(lastSearch()).toEqual({ query: 'wiki', limit: 500, ids: ['new'] }));
    await waitFor(() => expect($('#search-summary').textContent).toBe('4 results in 1 of 2 backups'));
    await user.click(item('old')); // tick it again: everything is covered, so no ids are sent
    await waitFor(() => expect(lastSearch()).toEqual({ query: 'wiki', limit: 500 }));
    await waitFor(() => expect($('#search-summary').textContent).toBe('4 results in all 2 backups'));
  });

  it('"Search in this backup" limits the search to that backup and focuses the search box', async () => {
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await user.click(screen.getByRole('button', { name: t('snapshotSearchLabel', dateOf(OLD)) }));

    expect(scopeButton().textContent).toBe(t('searchScopeSome', ['1', '2']));
    expect(document.activeElement).toBe($('#backups-search'));
    await user.keyboard('wiki');
    await waitFor(() => expect(has('#search-results')).toBe(true));
    expect(lastSearch()).toEqual({ query: 'wiki', limit: 500, ids: ['old'] });
    expect($('#search-summary').textContent).toBe('3 results in 1 of 2 backups');
  });

  it('keeps the choice when the search is cleared, and drops a backup that was deleted', async () => {
    let list = [...METAS];
    routeSend(searchRoute(() => list));
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await user.click(screen.getByRole('button', { name: t('snapshotSearchLabel', dateOf(OLD)) }));
    await searched(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(has('#snapshot-list')).toBe(true));
    expect(scopeButton().textContent).toBe(t('searchScopeSome', ['1', '2'])); // still chosen

    list = [METAS[1]!];
    await user.click(screen.getByRole('button', { name: t('snapshotDeleteLabel', dateOf(OLD)) }));
    await user.click(screen.getByRole('button', { name: t('snapshotConfirmDeleteLabel', dateOf(OLD)) }));
    await waitFor(() => expect(document.querySelectorAll('#snapshot-list > li')).toHaveLength(1));
    expect(has('#search-scope')).toBe(false); // one backup left: nothing to choose

    await searchFor(user, 'wiki');
    await waitFor(() => expect(lastSearch()).toEqual({ query: 'wiki', limit: 500 })); // the deleted id is not sent
  });

  it('has nothing to choose with a single backup', async () => {
    routeSend(searchRoute(() => [METAS[0]!]));
    const user = userEvent.setup();
    renderApp();
    await openBackups(user);
    await waitFor(() => expect(has('#snapshot-list')).toBe(true));
    expect(has('#search-scope')).toBe(false);
  });

  it('can include or leave out the file loaded in the Import tab', async () => {
    const user = userEvent.setup();
    renderApp();
    await loadFile(user);
    await openBackups(user);

    expect(scopeButton().textContent).toBe(t('searchScopeWithFile', t('searchScopeAll')));
    await openScope(user);
    expect(itemIds()).toEqual(['scope-all', 'new', 'old', 'scope-file']);
    expect(item('scope-file').textContent).toContain(t('searchLoadedFile', 'mine.json'));

    await user.click(item('scope-file')); // leave the file out
    expect(scopeButton().textContent).toBe(t('searchScopeAll'));
    await user.keyboard('{Escape}');
    await searched(user);
    expect(lastSearch()).toEqual({ query: 'wiki', limit: 500, ids: ['new', 'old'] });
    expect(rowNames()).not.toContain('Only in file wiki');
    expect($('#search-summary').textContent).toBe('4 results in 2 of 3 backups');

    await openScope(user);
    await user.click(item('scope-file')); // and back in
    await waitFor(() => expect(rowNames()).toContain('Only in file wiki'));
    expect($('#search-summary').textContent).toBe('5 results in all 3 backups');
  });

  it('can search just the loaded file', async () => {
    const user = userEvent.setup();
    renderApp();
    await loadFile(user);
    await openBackups(user);
    await openScope(user);
    await user.click(item('new'));
    await user.click(item('old'));
    expect(scopeButton().textContent).toBe(t('searchScopeFileOnly'));
    expect(item('scope-file').getAttribute('aria-disabled')).toBe('true'); // the last one
    await user.keyboard('{Escape}');

    await searched(user);
    expect(lastSearch()).toEqual({ query: 'wiki', limit: 500, ids: [] });
    expect(rowNames().sort()).toEqual(['Only in file wiki', 'Plain wiki page']);
    expect($('#search-summary').textContent).toBe('2 results in 1 of 3 backups');
  });
});
