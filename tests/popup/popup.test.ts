// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t, tp } from '@/lib/i18n';
import type { ImportState } from '@/lib/types';
import {
  backupFile,
  broadcast,
  callsOf,
  installI18n,
  makeBackup,
  renderApp,
  resetEnvironment,
  routeSend,
} from './helpers';

vi.mock('@/lib/messaging', () => ({ send: vi.fn() }));

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`No element matches ${selector}`);
  return el;
};

async function openTab(user: ReturnType<typeof userEvent.setup>, name: 'export' | 'import' | 'backups') {
  await user.click($(`#tab-${name}`));
}

async function chooseFile(user: ReturnType<typeof userEvent.setup>, file: File) {
  await openTab(user, 'import');
  await user.upload($<HTMLInputElement>('#import-file'), file);
  await screen.findByText(t('fileLoaded', file.name));
}

beforeEach(() => {
  installI18n();
  routeSend();
});
afterEach(resetEnvironment);

describe('tabs', () => {
  it('uses a roving tabindex and arrow keys', async () => {
    const user = userEvent.setup();
    renderApp();
    expect($('#tab-export').getAttribute('tabindex')).toBe('0');
    expect($('#tab-import').getAttribute('tabindex')).toBe('-1');

    $('#tab-export').focus();
    await user.keyboard('{ArrowRight}');
    expect($('#tab-import').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe($('#tab-import'));
    expect($('#import-panel').hidden).toBe(false);
    expect($('#export-panel').hidden).toBe(true);

    await user.keyboard('{End}');
    expect($('#tab-backups').getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect($('#tab-export').getAttribute('aria-selected')).toBe('true');
  });

  it('shows the detected browser from GET_STATE', async () => {
    renderApp();
    await waitFor(() => expect($('#browser-badge').textContent).toBe('Chrome'));
  });
});

describe('export', () => {
  it('disables the button when nothing is selected', async () => {
    const user = userEvent.setup();
    renderApp();
    const button = $<HTMLButtonElement>('#btn-export');
    expect(button.disabled).toBe(false);

    await user.click($('#ex-tabs'));
    await user.click($('#ex-bookmarks'));

    expect(button.disabled).toBe(true);
    expect($('#export-empty-hint').textContent).toBe(t('exportNothingSelected'));
    expect($('#export-empty-hint').classList.contains('hidden')).toBe(false);
  });

  it('sends EXPORT with the chosen options and reports the outcome', async () => {
    const user = userEvent.setup();
    routeSend({
      EXPORT: () => ({ ok: true, filename: 'x.json', stats: { windows: 2, tabs: 7, groups: 1, bookmarks: 0, skippedTabs: 0 } }),
    });
    renderApp();

    await user.type($('#ex-filter-domain'), 'github.com, wikipedia.org');
    await user.click($('#ex-bookmarks')); // off
    await user.click($('#ex-favicons')); // on (default off)
    await user.click($('#btn-export'));

    await waitFor(() => expect(callsOf('EXPORT')).toHaveLength(1));
    expect(callsOf('EXPORT')[0]).toEqual({
      options: {
        includeTabs: true,
        includeBookmarks: false,
        includeBookmarklets: true,
        includeFavicons: true,
        unwrapPlaceholders: true,
        includeWindowLayout: true,
        filters: { excludeInternal: true, domains: ['github.com', 'wikipedia.org'], applyToBookmarks: false },
      },
      saveAs: true,
    });
    const expected = t('exportDone', ['7', '2']);
    await waitFor(() => expect($('#export-result').textContent).toBe(expected));
    expect($('#status-msg').textContent).toBe(expected);
    expect($('#status-msg').classList.contains('is-success')).toBe(true);
  });

  it('has a bookmarklets option under Bookmarks that follows it', async () => {
    const user = userEvent.setup();
    routeSend({
      EXPORT: () => ({ ok: true, filename: 'x.json', stats: { windows: 0, tabs: 0, groups: 0, bookmarks: 3, skippedTabs: 0 } }),
    });
    renderApp();

    const box = $<HTMLInputElement>('#ex-bookmarklets');
    expect(box.checked).toBe(true);
    await user.click($('#ex-bookmarks')); // bookmarks off -> option unavailable
    expect(box.disabled).toBe(true);
    await user.click($('#ex-bookmarks')); // back on
    expect(box.disabled).toBe(false);

    await user.click(box); // off
    await user.click($('#btn-export'));
    await waitFor(() => expect(callsOf('EXPORT')).toHaveLength(1));
    expect((callsOf('EXPORT')[0] as { options: Record<string, unknown> }).options).toMatchObject({
      includeBookmarks: true,
      includeBookmarklets: false,
    });
  });

  it('shows the error when the export fails', async () => {
    const user = userEvent.setup();
    routeSend({ EXPORT: () => ({ ok: false, error: 'disk full' }) });
    renderApp();
    await user.click($('#btn-export'));
    await waitFor(() => expect($('#export-result').textContent).toBe(t('exportFailed', 'disk full')));
    expect($('#export-result').classList.contains('is-error')).toBe(true);
  });
});

describe('import', () => {
  it('shows a summary and the preview after choosing a file', async () => {
    const user = userEvent.setup();
    renderApp();
    await chooseFile(user, backupFile());

    expect($('#summary-format').textContent).toBe(t('summaryFormat', t('formatNative')));
    expect($('#summary-stats').textContent).toContain('5'); // tabs
    expect($('#preview-total').textContent).toBe(t('previewSelected', '5'));
    const tree = within($('#preview-tree'));
    expect(tree.getAllByRole('checkbox')).toHaveLength(3); // window, ungrouped, group
    expect(tree.getByText('Work')).toBeTruthy();
    expect($<HTMLButtonElement>('#btn-import').disabled).toBe(false);
  });

  it('updates the selected count (and the tri-state window box) when a group is deselected', async () => {
    const user = userEvent.setup();
    renderApp();
    await chooseFile(user, backupFile());

    const group = within($('#preview-tree')).getByRole<HTMLInputElement>('checkbox', { name: tp('previewGroupLabel', 3, ['Work', '1', '3']) });
    await user.click(group);

    expect($('#preview-total').textContent).toBe(t('previewSelected', '2'));
    const windowBox = within($('#preview-tree')).getAllByRole<HTMLInputElement>('checkbox')[0];
    expect(windowBox?.indeterminate).toBe(true);
    expect(windowBox?.checked).toBe(false);

    await user.click($('#btn-select-none'));
    expect($('#preview-total').textContent).toBe(t('previewSelected', '0'));
    expect($<HTMLButtonElement>('#btn-import').disabled).toBe(true);

    await user.click($('#btn-select-all'));
    expect($('#preview-total').textContent).toBe(t('previewSelected', '5'));
  });

  it('sends only the selected tabs with IMPORT_START', async () => {
    const user = userEvent.setup();
    renderApp();
    await chooseFile(user, backupFile());
    await user.click(within($('#preview-tree')).getByRole('checkbox', { name: tp('previewGroupLabel', 3, ['Work', '1', '3']) }));
    await user.click($('#btn-import'));

    await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
    const { data, options } = callsOf('IMPORT_START')[0] as { data: ReturnType<typeof makeBackup>; options: Record<string, unknown> };
    expect(data.windows[0]?.groups).toHaveLength(0);
    expect(data.windows[0]?.ungroupedTabs).toHaveLength(2);
    expect(options).toMatchObject({ importTabs: true, importBookmarks: false, restoreMode: 'discard', focusRestored: false });
  });

  it('offers bookmarklets only when the file has some, with a warning, and sends the choice', async () => {
    const user = userEvent.setup();
    renderApp();
    await chooseFile(user, backupFile(makeBackup(true)));
    expect(document.querySelector('#im-bookmarklets')).toBeNull(); // no bookmarklets in this file

    const withScripts = makeBackup(true);
    withScripts.bookmarks[0]?.children?.push(
      { title: 'Dark mode', url: 'javascript:void(document.body.style.filter="invert(1)")' },
      { title: 'Word count', url: 'javascript:alert(document.body.innerText.split(/\\s+/).length)' },
    );
    await chooseFile(user, backupFile(withScripts, 'with-bookmarklets.json'));

    const box = $<HTMLInputElement>('#im-bookmarklets');
    expect(box.checked).toBe(true);
    expect(box.closest('label')?.textContent).toBe(tp('importBookmarkletsOption', 2, '2'));
    expect($('#summary-warnings').textContent).toContain(tp('warnBookmarklets', 2, '2'));

    await user.click($('#im-bookmarks')); // bookmarks off -> option unavailable
    expect(box.disabled).toBe(true);
    await user.click($('#im-bookmarks'));
    await user.click(box); // off
    await user.click($('#btn-import'));
    await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
    expect(callsOf('IMPORT_START')[0]?.options).toMatchObject({ importBookmarks: true, importBookmarklets: false });
  });

  it('requires a confirmation before replacing bookmarks', async () => {
    const user = userEvent.setup();
    renderApp();
    await chooseFile(user, backupFile(makeBackup(true)));

    await user.click(screen.getByRole('radio', { name: t('bmReplace') }));
    expect($<HTMLInputElement>('#im-skip-dupes').disabled).toBe(true);
    await user.click($('#btn-import'));

    expect($('#replace-confirm')).toBeTruthy();
    expect(callsOf('IMPORT_START')).toHaveLength(0);
    expect($('#btn-import').classList.contains('hidden')).toBe(true);
    expect(document.activeElement).toBe($('#btn-replace-no')); // the safe choice has the focus

    // Going back cancels without sending anything.
    await user.click($('#btn-replace-no'));
    expect(document.querySelector('#replace-confirm')).toBeNull();
    expect(callsOf('IMPORT_START')).toHaveLength(0);

    // Confirming sends it.
    await user.click($('#btn-import'));
    await user.click($('#btn-replace-yes'));
    await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
    expect(callsOf('IMPORT_START')[0]?.options).toMatchObject({
      importBookmarks: true,
      bookmarkStrategy: 'replace',
      skipDuplicateBookmarks: false,
    });
  });

  it('withdraws a pending confirmation when an option changes', async () => {
    const user = userEvent.setup();
    renderApp();
    await chooseFile(user, backupFile(makeBackup(true)));
    await user.click(screen.getByRole('radio', { name: t('bmReplace') }));
    await user.click($('#btn-import'));
    expect($('#replace-confirm')).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: t('bmMerge') }));
    expect(document.querySelector('#replace-confirm')).toBeNull();
  });

  it('shows the notice for more than 200 selected tabs', async () => {
    const user = userEvent.setup();
    const big = makeBackup();
    big.windows[0]!.ungroupedTabs = Array.from({ length: 250 }, (_, i) => ({ url: `https://t${i}.example/`, title: '', pinned: false }));
    renderApp();
    await chooseFile(user, backupFile(big));
    expect($('#many-tabs-notice').textContent).toBe(t('importManyTabs', '253'));
  });

  it('rejects a file that is not a backup', async () => {
    const user = userEvent.setup();
    renderApp();
    await openTab(user, 'import');
    await user.upload($<HTMLInputElement>('#import-file'), new File(['{"hello": 1}'], 'nope.json', { type: 'application/json' }));
    await waitFor(() => expect($('#file-info').classList.contains('is-error')).toBe(true));
    expect(document.querySelector('#import-summary')).toBeNull();
    expect($<HTMLButtonElement>('#btn-import').disabled).toBe(true);
  });

  it('renders progress and then results from IMPORT_STATE broadcasts', async () => {
    renderApp();
    await waitFor(() => expect(callsOf('GET_STATE')).toHaveLength(1));

    const running: ImportState = { status: 'running', phase: 'tabs', current: 5, total: 10, message: '' };
    act(() => broadcast({ type: 'IMPORT_STATE', state: running }));

    expect($('#progress-bar').classList.contains('hidden')).toBe(false);
    expect($('#progress-bar').getAttribute('aria-valuenow')).toBe('50');
    expect($('#progress-text').textContent).toBe('5 / 10');
    expect($('#status-msg').textContent).toBe(t('phaseTabs'));
    expect($('#btn-cancel').classList.contains('hidden')).toBe(false);
    expect($<HTMLInputElement>('#import-file').disabled).toBe(true);

    const done: ImportState = {
      status: 'done',
      current: 10,
      total: 10,
      message: '',
      finishedAt: '2025-01-01T00:00:00.000Z',
      result: {
        tabs: 8,
        groups: 1,
        windows: 1,
        tabsSkipped: 1,
        tabsFailed: 1,
        bookmarks: 0,
        bookmarksSkipped: 0,
        bookmarksFailed: 0,
        failures: [{ kind: 'tab', url: 'chrome://settings', title: 'Settings', reason: 'internal-page' }],
        errors: [],
        warnings: { invalidTabs: 0, invalidWindows: 0, invalidBookmarks: 0, newerSchema: false },
        cancelled: false,
      },
    };
    act(() => broadcast({ type: 'IMPORT_STATE', state: done }));

    expect($('#progress-bar').classList.contains('hidden')).toBe(true);
    expect($('#results-card')).toBeTruthy();
    expect($('#results-summary').textContent).toBe(t('statusImportDoneIssues', ['8', '0']));
    expect($('#status-msg').textContent).toBe(t('statusImportDoneIssues', ['8', '0']));
    expect($('#results-stats').textContent).toContain('8');
    expect($('#results-failures-summary').textContent).toBe(tp('failuresSummary', 1, '1'));
    expect($('#results-failures-list').textContent).toContain('Settings');
    expect($('#results-failures-list').textContent).toContain(t('failureInternalPage'));

    // Dismissing hides the card until a new run finishes.
    await userEvent.setup().click($('#btn-results-dismiss'));
    expect(document.querySelector('#results-card')).toBeNull();
  });

  it('shows a restore that is already running when the popup opens', async () => {
    routeSend({
      GET_STATE: () => ({
        ok: true,
        browser: { key: 'chrome', name: 'Chrome', family: 'chromium', features: {} },
        importState: { status: 'running', phase: 'bookmarks', current: 1, total: 4, message: '' },
      }),
    });
    renderApp();
    await waitFor(() => expect($('#tab-import').getAttribute('aria-selected')).toBe('true'));
    expect($('#progress-text').textContent).toBe('1 / 4');
    expect($('#status-msg').textContent).toBe(t('phaseBookmarks'));
  });

  it('cancels a running restore', async () => {
    const user = userEvent.setup();
    renderApp();
    await waitFor(() => expect(callsOf('GET_STATE')).toHaveLength(1));
    act(() => broadcast({ type: 'IMPORT_STATE', state: { status: 'running', phase: 'tabs', current: 1, total: 4, message: '' } }));
    await user.click($('#btn-cancel'));
    await waitFor(() => expect(callsOf('IMPORT_CANCEL')).toHaveLength(1));
  });
});

describe('backups', () => {
  const snapshot = {
    id: 'snap-1',
    createdAt: '2025-02-03T10:00:00.000Z',
    reason: 'manual',
    stats: { windows: 1, tabs: 12, groups: 2, bookmarks: 3, skippedTabs: 0 },
    bytes: 2048,
    hash: 'abc',
  };

  it('lists the snapshots when the tab is opened', async () => {
    const user = userEvent.setup();
    routeSend({
      SNAPSHOTS_LIST: () => ({
        ok: true,
        snapshots: [snapshot, { ...snapshot, id: 'snap-2', reason: 'pre-replace' }],
        settings: { enabled: true, frequency: 'weekly', keep: 12, includeBookmarks: false },
        lastRun: null,
      }),
    });
    renderApp();
    expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(0); // fetched lazily
    await openTab(user, 'backups');

    await waitFor(() => expect(document.querySelectorAll('#snapshot-list > li')).toHaveLength(2));
    expect(document.querySelectorAll('.badge.is-safety')).toHaveLength(1);
    expect($<HTMLInputElement>('#bk-enabled').checked).toBe(true);
    expect($<HTMLSelectElement>('#bk-frequency').value).toBe('weekly');
    expect($<HTMLInputElement>('#bk-keep').value).toBe('12');
    expect($<HTMLInputElement>('#bk-bookmarks').checked).toBe(false);
    expect($('#snapshots-empty').classList.contains('hidden')).toBe(true);
    expect($('#bk-last-run').textContent).toBe(t('lastRunNever'));
  });

  it('shows the empty state without snapshots', async () => {
    const user = userEvent.setup();
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(1));
    expect($('#snapshots-empty').classList.contains('hidden')).toBe(false);
  });

  it('needs two clicks to delete a snapshot', async () => {
    const user = userEvent.setup();
    routeSend({ SNAPSHOTS_LIST: () => ({ ok: true, snapshots: [snapshot], settings: { enabled: false, frequency: 'daily', keep: 7, includeBookmarks: true }, lastRun: null }) });
    renderApp();
    await openTab(user, 'backups');
    const item = await waitFor(() => $('#snapshot-list > li'));
    const del = within(item).getByText(t('snapshotDelete'));

    await user.click(del);
    expect(callsOf('SNAPSHOT_DELETE')).toHaveLength(0);
    expect(del.textContent).toBe(t('snapshotConfirmDelete'));
    expect(del.classList.contains('is-confirm')).toBe(true);

    await user.click(del);
    await waitFor(() => expect(callsOf('SNAPSHOT_DELETE')).toHaveLength(1));
    expect(callsOf('SNAPSHOT_DELETE')[0]).toEqual({ id: 'snap-1' });
    await waitFor(() => expect($('#bk-action-msg').textContent).toBe(t('snapshotDeleted')));
  });

  it('disarms the delete button when focus leaves it', async () => {
    const user = userEvent.setup();
    routeSend({ SNAPSHOTS_LIST: () => ({ ok: true, snapshots: [snapshot], settings: { enabled: false, frequency: 'daily', keep: 7, includeBookmarks: true }, lastRun: null }) });
    renderApp();
    await openTab(user, 'backups');
    const item = await waitFor(() => $('#snapshot-list > li'));
    await user.click(within(item).getByText(t('snapshotDelete')));
    await user.click($('#btn-backup-now'));
    expect(within(item).queryByText(t('snapshotConfirmDelete'))).toBeNull();
    expect(callsOf('SNAPSHOT_DELETE')).toHaveLength(0);
  });

  it('loads a snapshot into the Import tab', async () => {
    const user = userEvent.setup();
    routeSend({
      SNAPSHOTS_LIST: () => ({ ok: true, snapshots: [snapshot], settings: { enabled: false, frequency: 'daily', keep: 7, includeBookmarks: true }, lastRun: null }),
      SNAPSHOT_GET: () => ({ ok: true, data: makeBackup() }),
    });
    renderApp();
    await openTab(user, 'backups');
    const item = await waitFor(() => $('#snapshot-list > li'));
    await user.click(within(item).getByText(t('snapshotRestore')));

    await waitFor(() => expect($('#tab-import').getAttribute('aria-selected')).toBe('true'));
    expect($('#summary-format').textContent).toBe(t('summaryFormat', t('formatSnapshot')));
    expect($('#preview-total').textContent).toBe(t('previewSelected', '5'));
  });

  it('validates the number of snapshots to keep before saving', async () => {
    const user = userEvent.setup();
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(1));
    const keep = $<HTMLInputElement>('#bk-keep');
    await user.clear(keep);
    await user.type(keep, '99');
    await user.click($('#btn-save-schedule'));
    expect($('#bk-settings-msg').textContent).toBe(t('autoKeepInvalid', ['1', '50']));
    expect(callsOf('SCHEDULE_SET')).toHaveLength(0);
  });
});

describe('theme and view', () => {
  it('toggles the theme and persists it', async () => {
    const user = userEvent.setup();
    localStorage.setItem('tabvault:theme', 'dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    renderApp();
    expect($('#btn-theme').getAttribute('aria-label')).toBe(t('themeToLight'));
    await user.click($('#btn-theme'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('tabvault:theme')).toBe('light');
    expect($('#btn-theme').getAttribute('aria-label')).toBe(t('themeToDark'));
  });
});
