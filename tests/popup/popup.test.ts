// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t, tp } from '@/lib/i18n';
import type { ImportState } from '@/lib/types';
import {
  backupFile,
  broadcast,
  callsOf,
  CHROME_INFO,
  IDLE_STATE,
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

const TAB_LABEL = { export: 'tabExport', import: 'tabImport', backups: 'tabBackups' } as const;
type TabName = keyof typeof TAB_LABEL;
/** Tabs are found by role and accessible name (Radix generates their ids). */
const tabEl = (name: TabName): HTMLElement => screen.getByRole('tab', { name: t(TAB_LABEL[name]) });

async function openTab(user: ReturnType<typeof userEvent.setup>, name: TabName) {
  await user.click(tabEl(name));
}

/** Outcome messages are toasts; returns the toast element holding `text`. */
async function findToast(text: string): Promise<HTMLElement> {
  // The same text may also be shown in the page (e.g. the results card).
  return waitFor(() => {
    const toast = screen
      .getAllByText(text)
      .map((node) => node.closest<HTMLElement>('[data-sonner-toast]'))
      .find((el): el is HTMLElement => el !== null);
    if (!toast) throw new Error(`No toast says "${text}"`);
    return toast;
  });
}

/** Collapsed settings sections (Filters, Options) must be opened before their controls exist. */
async function openSection(user: ReturnType<typeof userEvent.setup>, titleKey: string) {
  await user.click(screen.getByRole('button', { name: new RegExp(t(titleKey)) }));
}

const isOn = (selector: string) => $(selector).getAttribute('aria-checked') === 'true';

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
    expect(tabEl('export').getAttribute('aria-selected')).toBe('true');

    await user.click(tabEl('export'));
    await user.keyboard('{ArrowRight}');
    expect(tabEl('import').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabEl('import'));
    const panelOf = (name: TabName) => document.getElementById(tabEl(name).getAttribute('aria-controls') ?? '');
    expect(panelOf('import')?.getAttribute('data-state')).toBe('active');
    expect(panelOf('export')?.getAttribute('data-state')).toBe('inactive');

    await user.keyboard('{End}');
    expect(tabEl('backups').getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect(tabEl('export').getAttribute('aria-selected')).toBe('true');
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
  });

  it('sends EXPORT with the chosen options and reports the outcome', async () => {
    const user = userEvent.setup();
    routeSend({
      EXPORT: () => ({ ok: true, filename: 'x.json', stats: { windows: 2, tabs: 7, groups: 1, bookmarks: 0, skippedTabs: 0 } }),
    });
    renderApp();

    await openSection(user, 'exportFiltersLabel');
    await user.type($('#ex-filter-domain'), 'github.com, wikipedia.org');
    await user.click($('#ex-bookmarks')); // off
    await openSection(user, 'exportOptionsSummary');
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
    const toast = await findToast(t('exportDone', ['7', '2']));
    expect(toast.getAttribute('data-type')).toBe('success');
  });

  it('has a bookmarklets option under Bookmarks that follows it', async () => {
    const user = userEvent.setup();
    routeSend({
      EXPORT: () => ({ ok: true, filename: 'x.json', stats: { windows: 0, tabs: 0, groups: 0, bookmarks: 3, skippedTabs: 0 } }),
    });
    renderApp();

    const box = $<HTMLButtonElement>('#ex-bookmarklets');
    expect(isOn('#ex-bookmarklets')).toBe(true);
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

  it('shows live counts and a button that says what will be exported', async () => {
    const user = userEvent.setup();
    renderApp();
    const preview = screen.getByRole('region', { name: t('exportPreviewLabel') });
    await waitFor(() => expect(within(preview).getByText('7')).toBeTruthy());
    expect(within(preview).getByText('12')).toBeTruthy();
    expect($('#btn-export').textContent).toBe(t('exportButtonBoth'));

    await user.click($('#ex-bookmarks')); // tabs only
    await waitFor(() => expect($('#btn-export').textContent).toBe(tp('exportButtonTabs', 7, '7')));
    expect((callsOf('EXPORT_PREVIEW').at(-1) as { options: Record<string, unknown> }).options).toMatchObject({
      includeTabs: true,
      includeBookmarks: false,
    });
  });

  it('shows the error when the export fails', async () => {
    const user = userEvent.setup();
    routeSend({ EXPORT: () => ({ ok: false, error: 'disk full' }) });
    renderApp();
    await user.click($('#btn-export'));
    const toast = await findToast(t('exportFailed', 'disk full'));
    expect(toast.getAttribute('data-type')).toBe('error');
  });
});

describe('import', () => {
  type User = ReturnType<typeof userEvent.setup>;
  // Files are picked in the full-tab view (the popup redirects there); popup-mode tests opt out.
  beforeEach(() => history.replaceState(null, '', '/?view=tab'));
  const asPopup = () => history.replaceState(null, '', '/');
  const checkboxes = () => within($('#preview-tree')).getAllByRole<HTMLElement>('checkbox');
  const groupBox = () => within($('#preview-tree')).getByRole('checkbox', { name: tp('previewGroupLabel', 3, ['Work', '1', '3']) });
  const runningState: ImportState = { status: 'running', phase: 'tabs', current: 5, total: 10, message: '' };
  const doneState = (overrides: Partial<ImportState> = {}): ImportState => ({
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
    ...overrides,
  });
  async function openTabAndWait(user: User) {
    renderApp();
    await waitFor(() => expect(callsOf('GET_STATE')).toHaveLength(1));
    await openTab(user, 'import');
  }

  describe('choose a file', () => {
    it('starts with an empty state and no restore button', async () => {
      const user = userEvent.setup();
      renderApp();
      await openTab(user, 'import');

      const empty = within($('#import-empty'));
      expect(empty.getByText(t('importChooseFile'))).toBeTruthy();
      expect(empty.getByText(t('importFileSub'))).toBeTruthy();
      expect(document.querySelector('#btn-import')).toBeNull();
      expect(document.querySelector('#import-summary')).toBeNull();
    });

    it('opens the file dialog from the Choose file button', async () => {
      const user = userEvent.setup();
      renderApp();
      await openTab(user, 'import');
      const opened = vi.fn((event: Event) => event.preventDefault());
      $('#import-file').addEventListener('click', opened);

      await user.click(screen.getByRole('button', { name: t('importChooseButton') }));
      expect(opened).toHaveBeenCalledTimes(1);
    });

    it('opens the full tab view instead of the file dialog on Firefox', async () => {
      asPopup();
      const user = userEvent.setup();
      routeSend({
        GET_STATE: () => ({ ok: true, browser: { key: 'firefox', name: 'Firefox', family: 'firefox', features: {} }, importState: IDLE_STATE }),
      });
      renderApp();
      await waitFor(() => expect($('#browser-badge').textContent).toBe('Firefox'));
      await openTab(user, 'import');

      // preventDefault() makes dispatchEvent return false: no dialog.
      expect(fireEvent.click($('#import-file'))).toBe(false);
    });

    it('opens the full tab view instead of the file dialog on Chrome too', async () => {
      // Chrome closes the popup when the native file dialog takes focus (Linux and others),
      // which destroys the input and loses the chosen file.
      asPopup();
      const user = userEvent.setup();
      renderApp();
      await waitFor(() => expect($('#browser-badge').textContent).toBe('Chrome'));
      await openTab(user, 'import');
      expect($('#btn-choose-file').textContent).toBe(t('importChooseInTab'));
      expect($('#choose-in-tab-hint').textContent).toBe(t('importChooseInTabHint'));
      expect(fireEvent.click($('#import-file'))).toBe(false);
    });

    it('still loads a file dropped on the popup (no dialog involved)', async () => {
      asPopup();
      const user = userEvent.setup();
      renderApp();
      await openTab(user, 'import');
      fireEvent.drop($('#import-panel'), { dataTransfer: { files: [backupFile()] } });
      await waitFor(() => expect($('#import-summary')).toBeTruthy());
    });

    it('offers the normal Choose file button in the tab view', async () => {
      const user = userEvent.setup();
      renderApp();
      await openTab(user, 'import');
      expect($('#btn-choose-file').textContent).toBe(t('importChooseButton'));
      expect(document.querySelector('#choose-in-tab-hint')).toBeNull();
    });

    it('shows window names from a Session Buddy file in the preview', async () => {
      const user = userEvent.setup();
      renderApp();
      const json = JSON.stringify({
        collections: [{ title: 'Research', folders: [{ title: 'Docs', links: [{ url: 'https://a.example/' }, { url: 'https://b.example/' }] }] }],
      });
      await openTab(user, 'import');
      await user.upload($<HTMLInputElement>('#import-file'), new File([json], 'session-buddy.json', { type: 'application/json' }));
      const tree = await waitFor(() => $('#preview-tree'));
      expect(within(tree).getByText('Research · Docs')).toBeTruthy();
      expect(within(tree).getByRole('checkbox', { name: tp('previewWindowTitledLabel', 2, ['Research · Docs', '2']) })).toBeTruthy();
      expect($('#summary-format').textContent).toBe(t('summaryFormat', t('formatSessionBuddy')));
    });

    it('selects only the newest Session Buddy history snapshot by default', async () => {
      const user = userEvent.setup();
      renderApp();
      const snap = (created: number, urls: string[]) => ({ type: 'browser-closed', created, windows: [{ tabs: urls.map((url) => ({ url })) }] });
      const json = JSON.stringify({
        format: 'nxs.json.v2',
        history: [
          snap(Date.UTC(2026, 10, 8, 12, 30), ['https://a.example/', 'https://b.example/']),
          snap(Date.UTC(2026, 10, 8, 12, 11), ['https://a.example/', 'https://b.example/', 'https://c.example/']),
        ],
      });
      await openTab(user, 'import');
      await user.upload($<HTMLInputElement>('#import-file'), new File([json], 'session-buddy-backup.json', { type: 'application/json' }));
      await waitFor(() => $('#preview-tree'));

      const windowBoxes = checkboxes().filter((box) => box.id.match(/^pv-w\d+$/));
      expect(windowBoxes.map((box) => box.getAttribute('aria-checked'))).toEqual(['true', 'false']);
      expect($('#preview-total').textContent).toBe(t('previewSelected', '2'));
      expect($('#btn-import').textContent).toBe(tp('importButtonTabs', 2, '2'));

      // Older snapshots can still be added.
      await user.click(windowBoxes[1]!);
      expect($('#preview-total').textContent).toBe(t('previewSelected', '5'));
    });

    it('loads a file dropped on the panel and highlights the drop target', async () => {
      const user = userEvent.setup();
      renderApp();
      await openTab(user, 'import');
      const file = backupFile();

      fireEvent.dragOver($('#import-panel'), { dataTransfer: { files: [file] } });
      expect(screen.getByText(t('importDropHere'))).toBeTruthy();
      fireEvent.drop($('#import-panel'), { dataTransfer: { files: [file] } });

      await screen.findByText(t('fileLoaded', 'backup.json'));
      expect(screen.queryByText(t('importDropHere'))).toBeNull();
      expect($('#summary-format')).toBeTruthy();
    });

    it('rejects a file that is not a backup', async () => {
      const user = userEvent.setup();
      renderApp();
      await openTab(user, 'import');
      await user.upload($<HTMLInputElement>('#import-file'), new File(['{"hello": 1}'], 'nope.json', { type: 'application/json' }));

      await waitFor(() => expect($('#file-info').textContent).toContain(t('fileInvalid', 'X').split('X')[0]!));
      expect($('#file-info').getAttribute('role')).toBe('alert');
      expect(document.querySelector('#import-summary')).toBeNull();
      expect(document.querySelector('#btn-import')).toBeNull();
      expect($('#import-empty')).toBeTruthy(); // can try again
    });
  });

  describe('review', () => {
    it('shows a summary and the preview after choosing a file', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile());

      expect(document.querySelector('#import-empty')).toBeNull();
      expect($('#summary-format').textContent).toBe(t('summaryFormat', t('formatNative')));
      expect($('#summary-date').textContent).toContain(t('summaryDate', '').trim());
      expect($('#summary-stats').textContent).toContain('5'); // tabs
      expect($('#preview-total').textContent).toBe(t('previewSelected', '5'));
      expect(checkboxes()).toHaveLength(3); // window, ungrouped, group
      expect(within($('#preview-tree')).getByText('Work')).toBeTruthy();
      expect($<HTMLButtonElement>('#btn-import').disabled).toBe(false);
    });

    it('lets you choose another file from the summary', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile());
      const opened = vi.fn((event: Event) => event.preventDefault());
      $('#import-file').addEventListener('click', opened);

      await user.click(screen.getByRole('button', { name: t('importChooseAnother') }));
      expect(opened).toHaveBeenCalledTimes(1);
    });

    it('announces the tri-state window box and updates the selected count', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile());
      expect(checkboxes()[0]?.getAttribute('aria-checked')).toBe('true');

      await user.click(groupBox());

      expect($('#preview-total').textContent).toBe(t('previewSelected', '2'));
      expect(checkboxes()[0]?.getAttribute('aria-checked')).toBe('mixed'); // window: some selected
      expect(groupBox().getAttribute('aria-checked')).toBe('false');

      await user.click($('#btn-select-none'));
      expect($('#preview-total').textContent).toBe(t('previewSelected', '0'));
      expect($<HTMLButtonElement>('#btn-import').disabled).toBe(true);
      expect($('#import-empty-hint').textContent).toBe(t('importNothingSelected'));

      await user.click($('#btn-select-all'));
      expect($('#preview-total').textContent).toBe(t('previewSelected', '5'));
      expect(checkboxes()[0]?.getAttribute('aria-checked')).toBe('true');
    });

    it('checking a mixed window selects everything in it', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile());
      await user.click(groupBox());
      await user.click(checkboxes()[0]!);
      expect($('#preview-total').textContent).toBe(t('previewSelected', '5'));
    });

    it('shows a colored dot for a tab group', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile());
      expect($('#preview-tree .group-dot').getAttribute('data-color')).toBe('blue');
    });

    it('shows warnings from the file', async () => {
      const user = userEvent.setup();
      const backup = makeBackup();
      backup.source = { truncated: true } as typeof backup.source;
      renderApp();
      await chooseFile(user, backupFile(backup));
      expect($('#summary-warnings').textContent).toContain(t('warnTruncated'));
    });

    it('has a button that says what will be restored', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile(makeBackup(true)));
      expect($('#btn-import').textContent).toBe(t('importButtonBoth'));

      await user.click($('#im-bookmarks')); // tabs only
      expect($('#btn-import').textContent).toBe(tp('importButtonTabs', 5, '5'));
      await user.click(groupBox());
      expect($('#btn-import').textContent).toBe(tp('importButtonTabs', 2, '2'));

      await user.click($('#im-bookmarks')); // back on, then tabs off
      await user.click($('#im-tabs'));
      expect($('#btn-import').textContent).toBe(t('importButtonBookmarks'));
      expect(document.querySelector('#preview-tree')).toBeNull(); // nothing to pick from when not importing tabs
    });

    it('hides the rows for content the file does not have', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile()); // tabs only
      expect(document.querySelector('#im-tabs')).toBeTruthy();
      expect(document.querySelector('#im-bookmarks')).toBeNull();
      expect(document.querySelector('#bookmark-options')).toBeNull();
    });

    it('sends only the selected tabs with IMPORT_START', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile());
      await user.click(groupBox());
      await user.click($('#btn-import'));

      await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
      const { data, options } = callsOf('IMPORT_START')[0] as { data: ReturnType<typeof makeBackup>; options: Record<string, unknown> };
      expect(data.windows[0]?.groups).toHaveLength(0);
      expect(data.windows[0]?.ungroupedTabs).toHaveLength(2);
      expect(options).toMatchObject({ importTabs: true, importBookmarks: false, restoreMode: 'discard', focusRestored: false });
    });

    it('sends the tab options', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile());

      await openSection(user, 'importTabOptionsLabel');
      expect(isOn('#im-skip-open')).toBe(true);
      expect(isOn('#im-skip-blank')).toBe(true);
      expect(isOn('#im-restore-layout')).toBe(true);
      expect($('#im-restore-mode').textContent).toBe(t('loadDiscard'));
      await user.click($('#im-skip-open'));
      await user.click($('#im-restore-layout'));
      await user.click($('#btn-import'));

      await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
      expect(callsOf('IMPORT_START')[0]?.options).toMatchObject({ skipOpenTabs: false, skipBlankTabs: true, restoreWindowLayout: false });
    });

    it('chooses how tabs load', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile());
      await openSection(user, 'importTabOptionsLabel');

      await user.click($('#im-restore-mode'));
      await user.click(await screen.findByRole('option', { name: t('loadLazy') }));
      expect($('#im-restore-mode').textContent).toBe(t('loadLazy'));
      expect($('#tab-options').textContent).toContain(t('loadLazy')); // summary badge follows

      await user.click($('#btn-import'));
      await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
      expect(callsOf('IMPORT_START')[0]?.options).toMatchObject({ restoreMode: 'lazy' });
    });

    it('explains that this browser has no tab groups', async () => {
      const user = userEvent.setup();
      routeSend({
        // Not Firefox itself: Firefox sends file picking to the tab view.
        GET_STATE: () => ({ ok: true, browser: { key: 'other', name: 'Other', family: 'chromium', features: { tabGroups: false } }, importState: IDLE_STATE }),
      });
      renderApp();
      await waitFor(() => expect($('#browser-badge').textContent).toBe('Other'));
      await chooseFile(user, backupFile());
      await openSection(user, 'importTabOptionsLabel');
      expect($('#im-no-groups-hint').textContent).toBe(t('importNoTabGroups'));
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

      const box = $<HTMLButtonElement>('#im-bookmarklets');
      expect(isOn('#im-bookmarklets')).toBe(true);
      expect(screen.getByText(tp('importBookmarkletsOption', 2, '2'))).toBeTruthy();
      expect($('#summary-warnings').textContent).toContain(tp('warnBookmarklets', 2, '2'));

      await user.click($('#im-bookmarks')); // bookmarks off -> option unavailable
      expect(box.disabled).toBe(true);
      await user.click($('#im-bookmarks'));
      await user.click(box); // off
      await user.click($('#btn-import'));
      await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
      expect(callsOf('IMPORT_START')[0]?.options).toMatchObject({ importBookmarks: true, importBookmarklets: false });
    });

    it('sends the bookmark strategy and the duplicate setting', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile(makeBackup(true)));
      await openSection(user, 'importBookmarkOptionsLabel');
      expect($('#bookmark-options').textContent).toContain(t('bmMerge')); // summary badge

      expect(screen.getByRole('radio', { name: t('bmMerge') }).getAttribute('aria-checked')).toBe('true');
      await user.click(screen.getByRole('radio', { name: t('bmFolder') }));
      await user.click($('#im-skip-dupes')); // off
      await user.click($('#btn-import'));

      await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
      expect(callsOf('IMPORT_START')[0]?.options).toMatchObject({ bookmarkStrategy: 'folder', skipDuplicateBookmarks: false });
    });

    it('requires a confirmation before replacing bookmarks', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile(makeBackup(true)));
      await openSection(user, 'importBookmarkOptionsLabel');

      await user.click(screen.getByRole('radio', { name: t('bmReplace') }));
      expect($<HTMLButtonElement>('#im-skip-dupes').disabled).toBe(true);
      await user.click($('#btn-import'));

      const dialog = await screen.findByRole('alertdialog');
      expect(dialog.id).toBe('replace-confirm');
      expect(within(dialog).getByText(t('replaceConfirmTitle'))).toBeTruthy();
      expect(within(dialog).getByText(t('replaceConfirmText'))).toBeTruthy();
      expect(callsOf('IMPORT_START')).toHaveLength(0);
      await waitFor(() => expect(document.activeElement).toBe($('#btn-replace-no'))); // the safe choice has the focus

      // Going back cancels without sending anything.
      await user.click($('#btn-replace-no'));
      await waitFor(() => expect(document.querySelector('#replace-confirm')).toBeNull());
      expect(callsOf('IMPORT_START')).toHaveLength(0);

      // Escape is the same as going back.
      await user.click($('#btn-import'));
      await screen.findByRole('alertdialog');
      await user.keyboard('{Escape}');
      await waitFor(() => expect(document.querySelector('#replace-confirm')).toBeNull());
      expect(callsOf('IMPORT_START')).toHaveLength(0);

      // Confirming sends it.
      await user.click($('#btn-import'));
      await user.click(await waitFor(() => $('#btn-replace-yes')));
      await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
      expect(callsOf('IMPORT_START')[0]?.options).toMatchObject({
        importBookmarks: true,
        bookmarkStrategy: 'replace',
        skipDuplicateBookmarks: false,
      });
    });

    it('does not ask for confirmation when only tabs are restored', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile(makeBackup(true)));
      await openSection(user, 'importBookmarkOptionsLabel');
      await user.click(screen.getByRole('radio', { name: t('bmReplace') }));
      await user.click($('#im-bookmarks')); // bookmarks off -> nothing is replaced
      await user.click($('#btn-import'));

      await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
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

    it('shows a failed start as a message and a toast', async () => {
      const user = userEvent.setup();
      routeSend({ IMPORT_START: () => ({ ok: false, error: 'nope' }) });
      renderApp();
      await chooseFile(user, backupFile());
      await user.click($('#btn-import'));

      const message = t('importStartFailed', 'nope');
      await waitFor(() => expect($('#import-message').textContent).toBe(message));
      expect((await findToast(message)).getAttribute('data-type')).toBe('error');
    });
  });

  describe('a finished restore found when the popup opens', () => {
    const finishedOnOpen = () =>
      routeSend({ GET_STATE: () => ({ ok: true, browser: CHROME_INFO, importState: doneState() }) });

    it('shows the results on the Import tab but does not announce them again', async () => {
      finishedOnOpen();
      const user = userEvent.setup();
      await openTabAndWait(user);
      expect($('#results-card')).toBeTruthy();
      await openTab(user, 'export');
      await new Promise((r) => setTimeout(r, 50));
      const toasts = [...document.querySelectorAll('[data-sonner-toast]')].map((el) => el.textContent ?? '');
      expect(toasts.some((text) => text.includes(t('statusImportDoneIssues', ['8', '0'])))).toBe(false);
    });

    it('Done tells the background to forget it, so it does not come back', async () => {
      finishedOnOpen();
      const user = userEvent.setup();
      await openTabAndWait(user);
      await user.click($('#btn-results-dismiss'));
      expect(document.querySelector('#results-card')).toBeNull();
      expect(callsOf('IMPORT_DISMISS')).toHaveLength(1);
    });

    it('Restore another file forgets it too', async () => {
      finishedOnOpen();
      const user = userEvent.setup();
      await openTabAndWait(user);
      await user.click($('#btn-results-another'));
      expect(callsOf('IMPORT_DISMISS')).toHaveLength(1);
    });
  });

  describe('running and results', () => {
    it('renders the progress view from IMPORT_STATE broadcasts and cancels', async () => {
      const user = userEvent.setup();
      await openTabAndWait(user);
      act(() => broadcast({ type: 'IMPORT_STATE', state: runningState }));

      // On the Import tab only the progress view shows progress; the shell strip is for other tabs.
      expect(document.querySelector('#progress-bar')).toBeNull();
      expect(within($('#import-progress')).getByRole('progressbar', { name: t('progressLabel') }).getAttribute('aria-valuenow')).toBe('50');
      expect($('#import-progress-text').textContent).toBe('5 / 10');
      expect(within($('#import-progress')).getByText(t('phaseTabs'))).toBeTruthy();
      expect(within($('#import-progress')).getByText(t('importRunningNote'))).toBeTruthy();
      expect(document.querySelector('#import-empty')).toBeNull();
      expect($<HTMLInputElement>('#import-file').disabled).toBe(true);

      await openTab(user, 'export');
      expect($('#progress-bar').getAttribute('aria-valuenow')).toBe('50');
      expect($('#progress-text').textContent).toBe('5 / 10');
      await openTab(user, 'import');

      await user.click($('#btn-cancel'));
      await waitFor(() => expect(callsOf('IMPORT_CANCEL')).toHaveLength(1));

      act(() => broadcast({ type: 'IMPORT_STATE', state: { ...runningState, status: 'cancelling' } }));
      expect($<HTMLButtonElement>('#btn-cancel').disabled).toBe(true);
      expect(within($('#import-progress')).getByText(t('statusCancelling'))).toBeTruthy();
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
      await waitFor(() => expect(tabEl('import').getAttribute('aria-selected')).toBe('true'));
      expect($('#import-progress-text').textContent).toBe('1 / 4');
      expect(within($('#import-progress')).getByText(t('phaseBookmarks'))).toBeTruthy();
      expect($('#btn-cancel')).toBeTruthy();
    });

    it('reports a cancel request that fails', async () => {
      const user = userEvent.setup();
      routeSend({ IMPORT_CANCEL: () => ({ ok: false, error: 'busy' }) });
      await openTabAndWait(user);
      act(() => broadcast({ type: 'IMPORT_STATE', state: runningState }));
      await user.click($('#btn-cancel'));
      expect((await findToast('busy')).getAttribute('data-type')).toBe('error');
    });

    it('shows the results when the restore finishes, and Done dismisses them', async () => {
      const user = userEvent.setup();
      await openTabAndWait(user);
      act(() => broadcast({ type: 'IMPORT_STATE', state: runningState }));
      act(() => broadcast({ type: 'IMPORT_STATE', state: doneState() }));

      expect(document.querySelector('#import-progress')).toBeNull();
      expect(document.querySelector('#progress-bar')).toBeNull();
      expect($('#results-card')).toBeTruthy();
      expect($('#results-summary').textContent).toBe(t('statusImportDoneIssues', ['8', '0']));
      expect($('#results-summary').getAttribute('role')).toBe('alert');
      // The results view is on screen, so no toast repeats it.
      const toasts = [...document.querySelectorAll('[data-sonner-toast]')].map((el) => el.textContent ?? '');
      expect(toasts.some((text) => text.includes(t('statusImportDoneIssues', ['8', '0'])))).toBe(false);
      expect($('#results-stats').textContent).toContain('8');
      expect($('#results-failures-summary').textContent).toBe(tp('failuresSummary', 1, '1'));

      await user.click($('#results-failures-summary'));
      expect($('#results-failures-list').textContent).toContain('Settings');
      expect($('#results-failures-list').textContent).toContain(t('failureInternalPage'));

      // Dismissing hides the results until a new run finishes.
      await user.click($('#btn-results-dismiss'));
      expect(document.querySelector('#results-card')).toBeNull();
      expect($('#import-empty')).toBeTruthy();
    });

    it('announces the finish with a toast when another tab is open', async () => {
      const user = userEvent.setup();
      await openTabAndWait(user);
      act(() => broadcast({ type: 'IMPORT_STATE', state: runningState }));
      await openTab(user, 'export');
      act(() => broadcast({ type: 'IMPORT_STATE', state: doneState() }));
      expect((await findToast(t('statusImportDoneIssues', ['8', '0']))).getAttribute('data-type')).toBe('warning');
    });

    it('colours the summary by outcome', async () => {
      await openTabAndWait(userEvent.setup());
      const clean = doneState();
      clean.result = { ...clean.result!, tabsFailed: 0, failures: [] };
      act(() => broadcast({ type: 'IMPORT_STATE', state: clean }));
      expect($('#results-summary').textContent).toBe(t('statusImportDone', ['8', '0']));
      expect($('#results-summary').className).toContain('text-success');
      expect(document.querySelector('#results-failures')).toBeNull();

      act(() => broadcast({ type: 'IMPORT_STATE', state: { status: 'error', current: 0, total: 0, message: '', error: 'boom', finishedAt: 'later' } }));
      expect($('#results-summary').textContent).toBe(t('statusImportFailed', 'boom'));
      expect($('#results-summary').className).toContain('text-destructive');
    });

    it('lists problems and copies the failed items', async () => {
      const user = userEvent.setup();
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      await openTabAndWait(user);
      const state = doneState();
      state.result = { ...state.result!, errors: ['Disk is full'] };
      act(() => broadcast({ type: 'IMPORT_STATE', state }));

      expect($('#results-errors').textContent).toContain('Disk is full');
      await user.click($('#results-failures-summary'));
      await user.click($('#btn-copy-failures'));
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('chrome://settings'));
      expect((await findToast(t('failuresCopied'))).getAttribute('data-type')).toBe('success');
    });

    it('keeps the review (and its choices) hidden while restoring, and back after Done', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile());
      await user.click(groupBox()); // 2 selected
      const hidden = () => $('#btn-import').closest('.hidden') !== null;
      expect(hidden()).toBe(false);

      act(() => broadcast({ type: 'IMPORT_STATE', state: runningState }));
      expect(hidden()).toBe(true);
      expect($('#btn-cancel')).toBeTruthy();

      act(() => broadcast({ type: 'IMPORT_STATE', state: doneState() }));
      expect(hidden()).toBe(true);
      await user.click($('#btn-results-dismiss'));
      expect(hidden()).toBe(false);
      expect($('#preview-total').textContent).toBe(t('previewSelected', '2'));
    });

    it('Restore another file clears the loaded backup', async () => {
      const user = userEvent.setup();
      renderApp();
      await chooseFile(user, backupFile());
      act(() => broadcast({ type: 'IMPORT_STATE', state: runningState }));
      act(() => broadcast({ type: 'IMPORT_STATE', state: doneState() }));

      await user.click(screen.getByRole('button', { name: t('resultsRestoreAnother') }));
      expect(document.querySelector('#results-card')).toBeNull();
      expect(document.querySelector('#import-summary')).toBeNull();
      expect($('#import-empty')).toBeTruthy();
      expect(document.querySelector('#btn-import')).toBeNull();
    });

    it('refuses a file dropped while a restore is running', async () => {
      const user = userEvent.setup();
      await openTabAndWait(user);
      act(() => broadcast({ type: 'IMPORT_STATE', state: runningState }));
      fireEvent.drop($('#import-panel'), { dataTransfer: { files: [backupFile()] } });
      expect((await findToast(t('importBusy'))).getAttribute('data-type')).toBe('warning');
      expect(document.querySelector('#import-summary')).toBeNull();
    });
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
