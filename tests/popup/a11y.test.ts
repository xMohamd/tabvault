// @vitest-environment happy-dom
/**
 * Structural accessibility behaviour found by the real-browser axe audit (tests/e2e/a11y.mjs):
 * landmarks, headings, roles, tab stops and focus return. Colour contrast can only be checked in a real browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '@/lib/i18n';
import type { ImportState } from '@/lib/types';
import { backupFile, broadcast, installI18n, makeBackup, renderApp, resetEnvironment, routeSend } from './helpers';

vi.mock('@/lib/messaging', () => ({ send: vi.fn() }));

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`No element matches ${selector}`);
  return el;
};
const tabEl = (key: 'tabExport' | 'tabImport' | 'tabBackups') => screen.getByRole('tab', { name: t(key) });

async function loadBackup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(tabEl('tabImport'));
  await user.upload($<HTMLInputElement>('#import-file'), backupFile(makeBackup(true)));
  await screen.findByText(t('fileLoaded', 'backup.json'));
}

beforeEach(() => {
  installI18n();
  routeSend();
  history.replaceState(null, '', '/?view=tab'); // files are picked in the full-tab view
});
afterEach(resetEnvironment);

describe('landmarks and headings', () => {
  it('has one banner, one main containing the tabs, and a single h1', () => {
    renderApp();
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    const main = screen.getByRole('main');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(main.contains(screen.getByRole('tablist'))).toBe(true);
    for (const panel of screen.getAllByRole('tabpanel', { hidden: true })) expect(main.contains(panel)).toBe(true);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('keeps heading levels contiguous in the import review (the preview title is an h2, not an h3)', async () => {
    const user = userEvent.setup();
    renderApp();
    await loadBackup(user);
    const title = $('#preview-title');
    expect(title.tagName).toBe('H2');
    expect(document.querySelector('h3')).toBeNull();
    expect(screen.getByRole('group', { name: t('previewTitle') })).toBeTruthy();
  });
});

describe('tab stops', () => {
  it('takes the tab panels out of the tab order (their controls are the stops)', () => {
    renderApp();
    const panels = document.querySelectorAll('[role=tabpanel]');
    expect(panels.length).toBe(3);
    for (const panel of panels) expect(panel.getAttribute('tabindex')).toBe('-1');
  });

  it('hands focus from the tab list container to the selected tab', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(tabEl('tabImport')); // after a click Radix leaves the container tabbable
    const list = screen.getByRole('tablist');
    act(() => list.focus());
    expect(document.activeElement).toBe(tabEl('tabImport'));
  });
});

describe('live regions', () => {
  it('announces the restore phase in a status region that wraps the heading (a heading cannot be role=status)', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(tabEl('tabImport'));
    const state: ImportState = { status: 'running', phase: 'tabs', current: 5, total: 10, message: '' };
    act(() => broadcast({ type: 'IMPORT_STATE', state }));

    const progress = $('#import-progress');
    const heading = within(progress).getByRole('heading', { name: t('phaseTabs') });
    expect(heading.hasAttribute('role')).toBe(false);
    const status = heading.closest('[role=status]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toBe(t('phaseTabs')); // only the phase: the counter must not be announced on every tick
  });
});

describe('menus and dialogs', () => {
  it('keeps the page available to assistive tech while the header menu is open and renders it inside <main>', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click($('#btn-menu'));
    const menu = await screen.findByRole('menu');
    expect(screen.getByRole('main').contains(menu)).toBe(true);
    expect(document.querySelector('header')?.getAttribute('aria-hidden')).toBeNull();
    expect(screen.getByRole('main').getAttribute('aria-hidden')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe($('#btn-menu'));
  });

  it('returns focus to the Restore button when the replace confirmation is dismissed', async () => {
    const user = userEvent.setup();
    renderApp();
    await loadBackup(user);
    await user.click(screen.getByRole('button', { name: new RegExp(t('importBookmarkOptionsLabel')) }));
    await user.click(screen.getByRole('radio', { name: t('bmReplace') }));

    // Cancel
    await user.click($('#btn-import'));
    await screen.findByRole('alertdialog');
    await user.click($('#btn-replace-no'));
    await waitFor(() => expect(document.querySelector('#replace-confirm')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe($('#btn-import')));

    // Escape
    await user.click($('#btn-import'));
    await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('#replace-confirm')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe($('#btn-import')));
  });
});

describe('form fields', () => {
  it('ties the invalid keep count to its message and hint', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(tabEl('tabBackups'));
    await user.click(await screen.findByRole('button', { name: new RegExp(t('autoTitle')) }));
    const input = await waitFor(() => $<HTMLInputElement>('#bk-keep'));
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    await waitFor(() => expect(input.getAttribute('aria-invalid')).toBe('true'));
    expect(input.getAttribute('aria-describedby')).toBe('bk-keep-hint bk-settings-msg');
    expect($('#bk-settings-msg').getAttribute('role')).toBe('alert');
  });
});
