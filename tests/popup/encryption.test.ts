// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '@/lib/i18n';
import { encryptBackup } from '@/lib/crypto';
import { backupFile, callsOf, installI18n, makeBackup, renderApp, resetEnvironment, routeSend } from './helpers';

vi.mock('@/lib/messaging', () => ({ send: vi.fn() }));

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`No element matches ${selector}`);
  return el;
};

beforeEach(() => {
  installI18n();
  routeSend({ EXPORT: () => ({ ok: true, filename: 'x.json', stats: { windows: 1, tabs: 2, groups: 0, bookmarks: 0, bookmarklets: 0, skippedTabs: 0 } }) });
});
afterEach(resetEnvironment);

async function openEncryptFields(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: new RegExp(t('exportOptionsSummary')) }));
  await user.click($('#ex-encrypt'));
}

describe('export with a password', () => {
  it('hides the password fields until the switch is on', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: new RegExp(t('exportOptionsSummary')) }));
    expect(document.querySelector('#ex-password')).toBeNull();
    await user.click($('#ex-encrypt'));
    expect($('#ex-password').getAttribute('type')).toBe('password');
    expect($('#ex-password').getAttribute('autocomplete')).toBe('new-password');
    expect($('#ex-password-confirm').getAttribute('type')).toBe('password');
    expect(screen.getByText(t('exportEncryptWarning'))).toBeTruthy();
  });

  it('validates length and match, and disables Export until valid', async () => {
    const user = userEvent.setup();
    renderApp();
    await openEncryptFields(user);
    const button = $<HTMLButtonElement>('#btn-export');
    expect(button.disabled).toBe(true);

    await user.type($('#ex-password'), 'short');
    expect(screen.getByText(t('exportPasswordTooShort', 8))).toBeTruthy();
    expect($('#ex-password').getAttribute('aria-invalid')).toBe('true');
    expect(button.disabled).toBe(true);

    await user.type($('#ex-password'), 'er-password');
    expect(document.querySelector('#ex-password-error')).toBeNull();
    await user.type($('#ex-password-confirm'), 'different');
    expect(screen.getByText(t('exportPasswordMismatch'))).toBeTruthy();
    expect($('#ex-password-confirm').getAttribute('aria-invalid')).toBe('true');
    expect(button.disabled).toBe(true);

    await user.clear($('#ex-password-confirm'));
    await user.type($('#ex-password-confirm'), 'shorter-password');
    expect(button.disabled).toBe(false);
  });

  it('sends the password with EXPORT only, never with the preview', async () => {
    const user = userEvent.setup();
    renderApp();
    await openEncryptFields(user);
    await user.type($('#ex-password'), 'correct horse');
    await user.type($('#ex-password-confirm'), 'correct horse');
    await user.click($('#btn-export'));
    await waitFor(() => expect(callsOf('EXPORT')).toHaveLength(1));
    expect(callsOf("EXPORT")[0]?.options.password).toBe('correct horse');
    for (const call of callsOf('EXPORT_PREVIEW')) expect(JSON.stringify(call)).not.toContain('correct horse');
  });

  it('sends no password when protection is off', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click($('#btn-export'));
    await waitFor(() => expect(callsOf('EXPORT')).toHaveLength(1));
    expect(callsOf("EXPORT")[0]?.options).not.toHaveProperty('password');
  });

  it('forgets the password when the switch is turned off', async () => {
    const user = userEvent.setup();
    renderApp();
    await openEncryptFields(user);
    await user.type($('#ex-password'), 'correct horse');
    await user.click($('#ex-encrypt'));
    await user.click($('#ex-encrypt'));
    expect($<HTMLInputElement>('#ex-password').value).toBe('');
  });
});

describe('import of an encrypted file', () => {
  // The file picker only works in the full-tab view.
  beforeEach(() => history.replaceState(null, '', '/?view=tab'));

  async function chooseEncrypted(user: ReturnType<typeof userEvent.setup>) {
    const env = await encryptBackup(JSON.stringify(makeBackup()), 'correct horse', { iterations: 1000 });
    const file = new File([JSON.stringify(env)], 'tabs.encrypted.json', { type: 'application/json' });
    await user.click(screen.getByRole('tab', { name: t('tabImport') }));
    await user.upload($<HTMLInputElement>('#import-file'), file);
    await screen.findByText(t('importEncryptedNotice'));
  }

  it('asks for the password, rejects a wrong one, then shows the summary', async () => {
    const user = userEvent.setup();
    renderApp();
    await chooseEncrypted(user);

    await user.type($('#import-password'), 'nope nope{Enter}');
    expect(await screen.findByText(t('importWrongPassword'))).toBeTruthy();
    expect($('#import-password').getAttribute('aria-invalid')).toBe('true');
    // The error is linked to the field, and focus stays on it (readOnly, not disabled, while unlocking).
    expect($('#import-password').getAttribute('aria-describedby')).toBe('import-password-error');
    expect(document.activeElement).toBe($('#import-password'));
    expect($<HTMLInputElement>('#import-password').disabled).toBe(false);

    await user.clear($('#import-password'));
    await user.type($('#import-password'), 'correct horse');
    await user.click($('#btn-unlock'));
    expect(await screen.findByText(t('fileLoaded', 'tabs.encrypted.json'))).toBeTruthy();
    expect(document.querySelector('#import-password')).toBeNull();
  });

  it('lets the user back out with Choose another file', async () => {
    const user = userEvent.setup();
    renderApp();
    await chooseEncrypted(user);
    await user.click($('#btn-unlock-cancel'));
    expect(document.querySelector('#import-unlock')).toBeNull();
    expect(document.querySelector('#import-empty')).not.toBeNull();
  });

  it('still loads ordinary files', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('tab', { name: t('tabImport') }));
    await user.upload($<HTMLInputElement>('#import-file'), backupFile());
    expect(await screen.findByText(t('fileLoaded', 'backup.json'))).toBeTruthy();
  });
});
