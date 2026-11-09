// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '@/lib/i18n';
import { callsOf, installI18n, makeBackup, renderApp, resetEnvironment, routeSend } from './helpers';

vi.mock('@/lib/messaging', () => ({ send: vi.fn() }));

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`No element matches ${selector}`);
  return el;
};

const TAB_LABEL = { import: 'tabImport', backups: 'tabBackups' } as const;
type TabName = keyof typeof TAB_LABEL;
const tabEl = (name: TabName): HTMLElement => screen.getByRole('tab', { name: t(TAB_LABEL[name]) });
type User = ReturnType<typeof userEvent.setup>;
const openTab = (user: User, name: TabName) => user.click(tabEl(name));

/** Outcome messages are toasts; returns the toast element holding `text`. */
async function findToast(text: string): Promise<HTMLElement> {
  return waitFor(() => {
    const toast = screen
      .getAllByText(text)
      .map((node) => node.closest<HTMLElement>('[data-sonner-toast]'))
      .find((el): el is HTMLElement => el !== null);
    if (!toast) throw new Error(`No toast says "${text}"`);
    return toast;
  });
}

const openAutoSection = (user: User) => user.click(screen.getByRole('button', { name: new RegExp(t('autoTitle')) }));
const isOn = (selector: string) => $(selector).getAttribute('aria-checked') === 'true';

const settings = { enabled: false, frequency: 'daily', keep: 7, includeBookmarks: true };
const snapshot = {
  id: 'snap-1',
  createdAt: '2025-02-03T10:00:00.000Z',
  reason: 'manual',
  stats: { windows: 1, tabs: 12, groups: 2, bookmarks: 3, skippedTabs: 0 },
  bytes: 2048,
  hash: 'abc',
};
const listing = (snapshots: unknown[] = [snapshot], overrides: Record<string, unknown> = {}) => ({
  SNAPSHOTS_LIST: () => ({ ok: true, snapshots, settings: { ...settings, ...overrides }, lastRun: null }),
});

beforeEach(() => {
  installI18n();
  routeSend();
});
afterEach(resetEnvironment);

describe('backups', () => {
  it('lists the snapshots when the tab is opened', async () => {
    const user = userEvent.setup();
    routeSend(
      listing([snapshot, { ...snapshot, id: 'snap-2', reason: 'pre-replace' }], {
        enabled: true,
        frequency: 'weekly',
        keep: 12,
        includeBookmarks: false,
      }),
    );
    renderApp();
    expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(0); // fetched lazily
    await openTab(user, 'backups');

    await waitFor(() => expect(document.querySelectorAll('#snapshot-list > li')).toHaveLength(2));
    expect($('#snapshot-count').textContent).toBe('2');
    expect(screen.getByText(t('reasonManual'))).toBeTruthy();
    expect(screen.getByText(t('reasonPreReplace'))).toBeTruthy();
    expect(document.querySelector('#snapshots-empty')).toBeNull();

    // The collapsed section summarizes the schedule; its controls reflect the settings.
    expect(screen.getByText(`${t('freqWeeklyShort')} · keep 12`)).toBeTruthy();
    await openAutoSection(user);
    expect(isOn('#bk-enabled')).toBe(true);
    expect(within($('#bk-frequency')).getByRole('radio', { name: t('freqWeeklyShort') }).getAttribute('aria-checked')).toBe('true');
    expect($<HTMLInputElement>('#bk-keep').value).toBe('12');
    expect(isOn('#bk-bookmarks')).toBe(false);
    expect($('#bk-last-run').textContent).toBe(t('lastRunNever'));
  });

  it('shows the empty state without snapshots', async () => {
    const user = userEvent.setup();
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect($('#snapshots-empty')).toBeTruthy());
    expect(within($('#snapshots-empty')).getByText(t('snapshotsNote'))).toBeTruthy();
    expect(document.querySelector('#snapshot-list')).toBeNull();
  });

  it('needs two clicks to delete a snapshot', async () => {
    const user = userEvent.setup();
    routeSend(listing());
    renderApp();
    await openTab(user, 'backups');
    const item = await waitFor(() => $('#snapshot-list > li'));
    const date = /\d{4}/; // the label embeds the localized date
    const del = within(item).getByRole('button', { name: new RegExp(`^${t('snapshotDeleteLabel', '').trim()}`) });

    await user.click(del);
    expect(callsOf('SNAPSHOT_DELETE')).toHaveLength(0);
    expect(del.textContent).toBe(t('snapshotConfirmDelete'));
    expect(del.getAttribute('aria-label')).toMatch(date);

    await user.click(del);
    await waitFor(() => expect(callsOf('SNAPSHOT_DELETE')).toHaveLength(1));
    expect(callsOf('SNAPSHOT_DELETE')[0]).toEqual({ id: 'snap-1' });
    await findToast(t('snapshotDeleted'));
  });

  it('disarms the delete button when focus leaves it', async () => {
    const user = userEvent.setup();
    routeSend(listing());
    renderApp();
    await openTab(user, 'backups');
    const item = await waitFor(() => $('#snapshot-list > li'));
    const del = within(item).getByRole('button', { name: new RegExp(`^${t('snapshotDeleteLabel', '').trim()}`) });
    await user.click(del);
    expect(within(item).getByText(t('snapshotConfirmDelete'))).toBeTruthy();

    await user.click($('#btn-backup-now'));
    expect(within(item).queryByText(t('snapshotConfirmDelete'))).toBeNull();
    expect(callsOf('SNAPSHOT_DELETE')).toHaveLength(0);
  });

  it('loads a snapshot into the Import tab', async () => {
    const user = userEvent.setup();
    routeSend({ ...listing(), SNAPSHOT_GET: () => ({ ok: true, data: makeBackup() }) });
    renderApp();
    await openTab(user, 'backups');
    const item = await waitFor(() => $('#snapshot-list > li'));
    await user.click(within(item).getByText(t('snapshotRestore')));

    await waitFor(() => expect(tabEl('import').getAttribute('aria-selected')).toBe('true'));
    expect(callsOf('SNAPSHOT_GET')[0]).toEqual({ id: 'snap-1' });
    expect($('#summary-format').textContent).toBe(t('summaryFormat', t('formatSnapshot')));
    expect($('#preview-total').textContent).toBe(t('previewSelected', '5'));
  });

  it('creates a snapshot with Back up now and refreshes the list', async () => {
    const user = userEvent.setup();
    let snapshots: unknown[] = [];
    routeSend({
      SNAPSHOTS_LIST: () => ({ ok: true, snapshots, settings, lastRun: null }),
      SNAPSHOT_CREATE: () => {
        snapshots = [snapshot];
        return { ok: true };
      },
    });
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect($('#snapshots-empty')).toBeTruthy());

    await user.click($('#btn-backup-now'));
    await waitFor(() => expect(callsOf('SNAPSHOT_CREATE')).toHaveLength(1));
    await findToast(t('backupNowDone'));
    await waitFor(() => expect(document.querySelectorAll('#snapshot-list > li')).toHaveLength(1));
    expect(document.querySelector('#snapshots-empty')).toBeNull();
  });

  it('reports a failed Back up now as an error toast', async () => {
    const user = userEvent.setup();
    routeSend({ SNAPSHOT_CREATE: () => ({ ok: false, error: 'disk full' }) });
    renderApp();
    await openTab(user, 'backups');
    await user.click($('#btn-backup-now'));
    await findToast(t('backupNowFailed', 'disk full'));
  });
});

describe('automatic backups autosave', () => {
  const echoSettings = (payload: Record<string, unknown>) => ({ ok: true, settings: payload.settings });

  it('saves a switch right away with the full settings', async () => {
    const user = userEvent.setup();
    routeSend({ SCHEDULE_SET: echoSettings });
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(1));
    await openAutoSection(user);

    await user.click($('#bk-enabled'));
    await waitFor(() => expect(callsOf('SCHEDULE_SET')).toHaveLength(1));
    expect(callsOf('SCHEDULE_SET')[0]).toEqual({
      settings: { enabled: true, frequency: 'daily', keep: 7, includeBookmarks: true, saveToFiles: false, fileLocation: 'downloads', downloadsFolder: 'TabVault' },
    });
    await findToast(t('autoSaved'));
    expect(isOn('#bk-enabled')).toBe(true);

    await user.click($('#bk-bookmarks'));
    await waitFor(() => expect(callsOf('SCHEDULE_SET')).toHaveLength(2));
    expect(callsOf('SCHEDULE_SET')[1]?.settings.includeBookmarks).toBe(false);
  });

  it('saves the frequency right away', async () => {
    const user = userEvent.setup();
    routeSend({ SCHEDULE_SET: echoSettings });
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(1));
    await openAutoSection(user);

    await user.click(within($('#bk-frequency')).getByRole('radio', { name: t('freqHourlyShort') }));
    await waitFor(() => expect(callsOf('SCHEDULE_SET')).toHaveLength(1));
    expect(callsOf('SCHEDULE_SET')[0]?.settings.frequency).toBe('hourly');
  });

  it('saves a valid keep count on blur and on Enter', async () => {
    const user = userEvent.setup();
    routeSend({ SCHEDULE_SET: echoSettings });
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(1));
    await openAutoSection(user);
    const keep = $<HTMLInputElement>('#bk-keep');

    await user.clear(keep);
    await user.type(keep, '12');
    expect(callsOf('SCHEDULE_SET')).toHaveLength(0); // typing alone does not save
    await user.tab();
    await waitFor(() => expect(callsOf('SCHEDULE_SET')).toHaveLength(1));
    expect(callsOf('SCHEDULE_SET')[0]?.settings.keep).toBe(12);

    await user.clear(keep);
    await user.type(keep, '20{Enter}');
    await waitFor(() => expect(callsOf('SCHEDULE_SET')).toHaveLength(2));
    expect(callsOf('SCHEDULE_SET')[1]?.settings.keep).toBe(20);
    expect(document.querySelector('#bk-settings-msg')).toBeNull();
  });

  it('does not send an invalid keep count and explains why', async () => {
    const user = userEvent.setup();
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(1));
    await openAutoSection(user);
    const keep = $<HTMLInputElement>('#bk-keep');

    await user.clear(keep);
    await user.type(keep, '99{Enter}');
    expect($('#bk-settings-msg').textContent).toBe(t('autoKeepInvalid', ['1', '50']));
    expect(keep.getAttribute('aria-invalid')).toBe('true');
    expect(callsOf('SCHEDULE_SET')).toHaveLength(0);

    await user.tab(); // blur does not send either
    expect(callsOf('SCHEDULE_SET')).toHaveLength(0);

    await user.clear(keep);
    await user.type(keep, '5{Enter}');
    await waitFor(() => expect(callsOf('SCHEDULE_SET')).toHaveLength(1));
    expect(document.querySelector('#bk-settings-msg')).toBeNull();
  });

  it('keeps the last saved keep count when a switch is toggled with an invalid one typed', async () => {
    const user = userEvent.setup();
    routeSend({ SCHEDULE_SET: echoSettings });
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(1));
    await openAutoSection(user);

    await user.clear($('#bk-keep'));
    await user.type($('#bk-keep'), '99');
    await user.click($('#bk-enabled'));
    await waitFor(() => expect(callsOf('SCHEDULE_SET')).toHaveLength(1));
    expect(callsOf('SCHEDULE_SET')[0]?.settings.keep).toBe(7);
  });

  it('shows an error toast and reverts when saving fails', async () => {
    const user = userEvent.setup();
    routeSend({ SCHEDULE_SET: () => ({ ok: false, error: 'nope' }) });
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(1));
    await openAutoSection(user);

    await user.click($('#bk-enabled'));
    await findToast(t('autoSaveFailed', 'nope'));
    await waitFor(() => expect(isOn('#bk-enabled')).toBe(false));
  });
});

describe('automatic backup files', () => {
  it('autosaves the "also save as a file" switch', async () => {
    const user = userEvent.setup();
    routeSend({ SCHEDULE_SET: (payload) => ({ ok: true, settings: payload.settings }) });
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(callsOf('SNAPSHOTS_LIST')).toHaveLength(1));
    await openAutoSection(user);

    expect(isOn('#bk-files')).toBe(false);
    expect(screen.getByLabelText(t('autoSaveFiles'))).toBe($('#bk-files'));
    expect(screen.getByText(t('autoSaveFilesHint', '7'))).toBeTruthy();
    await user.click($('#bk-files'));
    await waitFor(() => expect(callsOf('SCHEDULE_SET')).toHaveLength(1));
    expect(callsOf('SCHEDULE_SET')[0]?.settings.saveToFiles).toBe(true);
    await findToast(t('autoSaved'));
    expect(isOn('#bk-files')).toBe(true);
  });

  it('shows a file indicator on snapshots that were saved as files', async () => {
    const user = userEvent.setup();
    routeSend(listing([{ ...snapshot, reason: 'scheduled', file: { downloadId: 4, filename: 'TabVault/tabs-backup-x.json' } }, { ...snapshot, id: 'snap-2' }]));
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(document.querySelectorAll('#snapshot-list > li')).toHaveLength(2));
    const rows = document.querySelectorAll<HTMLElement>('#snapshot-list > li');
    expect(within(rows[0]!).getByRole('img', { name: t('snapshotFileSaved', 'TabVault/tabs-backup-x.json') })).toBeTruthy();
    expect(within(rows[1]!).queryByRole('img')).toBeNull();
  });

  it('warns when the last backup could not be saved as a file', async () => {
    const user = userEvent.setup();
    routeSend({
      SNAPSHOTS_LIST: () => ({ ok: true, snapshots: [], settings, lastRun: { at: '2025-02-03T10:00:00.000Z', ok: true, error: 'File not saved: disk full' } }),
    });
    renderApp();
    await openTab(user, 'backups');
    await openAutoSection(user);
    await waitFor(() => expect($('#bk-last-run').textContent).toContain('File not saved: disk full'));
    expect($('#bk-last-run').className).toContain('text-warning');
  });
});

describe('quick saves', () => {
  it('labels a quick save and shows what was saved', async () => {
    const user = userEvent.setup();
    routeSend(
      listing([{ ...snapshot, reason: 'quick', scope: { windowId: 5, title: 'Window: GitHub' }, stats: { ...snapshot.stats, tabs: 6, bookmarks: 0 } }]),
    );
    renderApp();
    await openTab(user, 'backups');
    const item = await waitFor(() => $('#snapshot-list > li'));
    expect(within(item).getByText(t('reasonQuick'))).toBeTruthy();
    expect(within(item).getByText(/^Window: GitHub · 6 tabs/)).toBeTruthy();
  });
});

describe('compare snapshots', () => {
  const tab = (url: string, title = url) => ({ url, title, pinned: false });
  const backupOf = (urls: string[]) => ({
    schemaVersion: '1.1',
    exportedAt: null,
    source: {},
    windows: [{ ungroupedTabs: urls.map((u) => tab(u)), groups: [] }],
    bookmarks: [],
  });
  const older = { ...snapshot, id: 'old', createdAt: '2025-02-03T10:00:00.000Z' };
  const newer = { ...snapshot, id: 'new', createdAt: '2025-02-08T14:13:00.000Z' };
  const bodies: Record<string, unknown> = {
    old: backupOf(['https://keep.test/', 'https://gone.test/']),
    new: backupOf(['https://keep.test/', 'https://fresh.test/', 'https://fresh2.test/']),
  };
  const route = () => routeSend({ ...listing([newer, older]), SNAPSHOT_GET: (p) => ({ ok: true, data: bodies[p.id as string] }) });

  it('compares older → newer whatever the selection order, then goes back', async () => {
    const user = userEvent.setup();
    route();
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(document.querySelectorAll('#snapshot-list > li')).toHaveLength(2));

    await user.click($('#btn-compare'));
    expect(($('#btn-compare-run') as HTMLButtonElement).disabled).toBe(true);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    await user.click(boxes[0]!); // the newer one first
    expect(($('#btn-compare-run') as HTMLButtonElement).disabled).toBe(true);
    await user.click(boxes[1]!);
    expect(($('#btn-compare-run') as HTMLButtonElement).disabled).toBe(false);
    await user.click($('#btn-compare-run'));

    await waitFor(() => expect($('#snapshot-compare')).toBeTruthy());
    expect(callsOf('SNAPSHOT_GET').map((c) => c.id).sort()).toEqual(['new', 'old']);
    const fmtDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    expect($('#compare-title').textContent).toBe(
      t('compareTitle', [fmtDate.format(new Date(older.createdAt)), fmtDate.format(new Date(newer.createdAt))]),
    );
    const summary = $('#compare-summary').textContent ?? '';
    expect(summary).toContain(t('compareChipTabsAdded', '2'));
    expect(summary).toContain(t('compareChipTabsRemoved', '1'));

    await user.click(screen.getByRole('button', { name: t('compareAddedTabs', '2') }));
    expect(screen.getByText('https://fresh.test/')).toBeTruthy();

    await user.click($('#compare-back'));
    await waitFor(() => expect(document.querySelector('#snapshot-compare')).toBeNull());
    expect(document.querySelectorAll('#snapshot-list > li')).toHaveLength(2);
    expect(document.querySelector('#btn-compare')).toBeTruthy();
  });

  it('says there are no differences for identical snapshots', async () => {
    const user = userEvent.setup();
    bodies.new = bodies.old;
    route();
    try {
      renderApp();
      await openTab(user, 'backups');
      await waitFor(() => expect(document.querySelectorAll('#snapshot-list > li')).toHaveLength(2));
      await user.click($('#btn-compare'));
      for (const box of screen.getAllByRole('checkbox')) await user.click(box);
      await user.click($('#btn-compare-run'));
      await waitFor(() => expect(screen.getByText(t('compareNone'))).toBeTruthy());
    } finally {
      bodies.new = backupOf(['https://keep.test/', 'https://fresh.test/', 'https://fresh2.test/']);
    }
  });

  it('only offers Compare with at least two snapshots', async () => {
    const user = userEvent.setup();
    routeSend(listing());
    renderApp();
    await openTab(user, 'backups');
    await waitFor(() => expect(document.querySelectorAll('#snapshot-list > li')).toHaveLength(1));
    expect(document.querySelector('#btn-compare')).toBeNull();
  });
});
