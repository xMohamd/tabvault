// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '@/lib/i18n';
import type { Backup } from '@/lib/schema';
import {
  backupFile,
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
const has = (selector: string) => document.querySelector(selector) !== null;
const isOn = (selector: string) => $(selector).getAttribute('aria-checked') === 'true';
type User = ReturnType<typeof userEvent.setup>;

const FIREFOX_INFO = { ...CHROME_INFO, key: 'firefox', name: 'Firefox', family: 'gecko' };
const browserReply = (info: object) => ({
  GET_STATE: () => ({ ok: true, browser: info, importState: IDLE_STATE }),
});

/** Same as makeBackup, with Firefox containers on two tabs. */
function containerBackup(): Backup {
  const backup = makeBackup();
  const first = backup.windows[0]?.ungroupedTabs[0];
  if (first) first.container = { name: 'Work', color: 'blue' };
  return backup;
}

async function load(user: User, file: File = backupFile()) {
  await user.click(screen.getByRole('tab', { name: t('tabImport') }));
  await user.upload($<HTMLInputElement>('#import-file'), file);
  await screen.findByText(t('fileLoaded', file.name));
}
const openTabOptions = (user: User) => user.click(screen.getByRole('button', { name: new RegExp(t('importTabOptionsLabel')) }));
async function startImport(user: User) {
  await user.click($('#btn-import'));
  await waitFor(() => expect(callsOf('IMPORT_START')).toHaveLength(1));
  return callsOf('IMPORT_START')[0]?.options as Record<string, unknown>;
}

beforeEach(() => {
  history.replaceState(null, '', '/?view=tab'); // file picking only works in the full-tab view
  installI18n();
  routeSend();
});
afterEach(resetEnvironment);

describe('open in', () => {
  it('defaults to new windows', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await openTabOptions(user);

    expect($('#im-target-new-windows').getAttribute('aria-checked')).toBe('true');
    expect($('#im-target-current-window').getAttribute('aria-checked')).toBe('false');
    expect(await startImport(user)).toMatchObject({ target: 'new-windows', mergeGroups: false });
  });

  it('sends the current-window target, and the layout switch no longer applies', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await openTabOptions(user);
    expect(isOn('#im-restore-layout')).toBe(true);

    await user.click($('#im-target-current-window'));

    expect($('#im-target-current-window').getAttribute('aria-checked')).toBe('true');
    expect($('#im-restore-layout').hasAttribute('disabled')).toBe(true);
    expect(isOn('#im-restore-layout')).toBe(false);
    expect($('#tab-options').textContent).toContain(t('importLayoutNewOnly'));
    expect($('#tab-options').textContent).toContain(t('importTargetCurrent')); // summary badge follows

    expect(await startImport(user)).toMatchObject({ target: 'current-window', restoreWindowLayout: false });
  });

  it('brings the layout switch back when switching to new windows again', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await openTabOptions(user);
    await user.click($('#im-target-current-window'));
    await user.click($('#im-target-new-windows'));

    expect($('#im-restore-layout').hasAttribute('disabled')).toBe(false);
    expect(isOn('#im-restore-layout')).toBe(true);
    expect(await startImport(user)).toMatchObject({ target: 'new-windows', restoreWindowLayout: true });
  });
});

describe('merge groups', () => {
  it('is off by default and sent when turned on', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user);
    await openTabOptions(user);
    expect(isOn('#im-merge-groups')).toBe(false);
    expect(screen.getByText(t('importMergeGroupsHint'))).toBeTruthy();

    await user.click($('#im-merge-groups'));
    expect(isOn('#im-merge-groups')).toBe(true);
    expect(await startImport(user)).toMatchObject({ mergeGroups: true });
  });

  it('is hidden in browsers without tab groups', async () => {
    const user = userEvent.setup();
    routeSend(browserReply({ ...CHROME_INFO, features: { ...CHROME_INFO.features, tabGroups: false } }));
    renderApp();
    await load(user);
    await openTabOptions(user);

    expect(has('#im-merge-groups')).toBe(false);
    expect(await startImport(user)).toMatchObject({ mergeGroups: false });
  });
});

describe('containers', () => {
  it('is not shown on Chrome, even if the file has containers', async () => {
    const user = userEvent.setup();
    renderApp();
    await load(user, backupFile(containerBackup()));
    await openTabOptions(user);

    expect(has('#im-containers')).toBe(false);
    expect(await startImport(user)).not.toHaveProperty('restoreContainers');
  });

  it('is not shown on Firefox when no tab has a container', async () => {
    const user = userEvent.setup();
    routeSend(browserReply(FIREFOX_INFO));
    renderApp();
    await load(user);
    await openTabOptions(user);

    expect(has('#im-containers')).toBe(false);
  });

  it('is on by default on Firefox when the file has containers, and can be turned off', async () => {
    const user = userEvent.setup();
    routeSend(browserReply(FIREFOX_INFO));
    renderApp();
    await load(user, backupFile(containerBackup()));
    await openTabOptions(user);

    expect(isOn('#im-containers')).toBe(true);
    await user.click($('#im-containers'));
    expect(isOn('#im-containers')).toBe(false);
    expect(await startImport(user)).toMatchObject({ restoreContainers: false });
  });

  it('sends restoreContainers true by default on Firefox', async () => {
    const user = userEvent.setup();
    routeSend(browserReply(FIREFOX_INFO));
    renderApp();
    await load(user, backupFile(containerBackup()));
    expect(await startImport(user)).toMatchObject({ restoreContainers: true });
  });
});
