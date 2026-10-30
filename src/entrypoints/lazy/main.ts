/**
 * Lazy placeholder page: shows the saved tab and navigates to it the first
 * time the tab becomes visible, so restored tabs don't all load at once.
 */
import { browser } from 'wxt/browser';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'file:']);

/** Localized string with an English fallback (the page may outlive a locale change). */
function msg(key: string, fallback: string): string {
  try {
    return (browser.i18n as unknown as { getMessage(key: string): string }).getMessage(key) || fallback;
  } catch {
    return fallback;
  }
}

const isSafeFavicon = (value: string): boolean => /^https?:\/\//i.test(value) || /^data:image\//i.test(value);

/** The URL when it uses an allowed scheme, otherwise null. */
function validateUrl(value: string): string | null {
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function setFavicon(favicon: string): void {
  if (!favicon || !isSafeFavicon(favicon)) return;
  const img = byId<HTMLImageElement>('favicon');
  img.src = favicon;
  img.hidden = false;
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = favicon;
  document.head.appendChild(link);
}

function init(): void {
  const params = new URLSearchParams(location.search);
  const rawUrl = params.get('url') || '';
  const title = params.get('title') || '';
  const target = validateUrl(rawUrl);

  document.title = title || rawUrl || document.title;
  byId('title').textContent = title || rawUrl;
  byId('url').textContent = rawUrl;
  setFavicon(params.get('favicon') || '');

  const button = byId<HTMLButtonElement>('load');
  button.textContent = msg('lazyLoadButton', 'Load page');
  byId('hint').textContent = msg('lazyHint', 'This tab was restored without loading. It opens when you switch to it.');
  if (!target) {
    const error = byId('error');
    error.textContent = msg('lazyInvalidUrl', 'This placeholder has no valid address to open.');
    error.hidden = false;
    button.hidden = true;
    return;
  }

  let navigating = false;
  const load = () => {
    if (navigating) return;
    navigating = true;
    location.replace(target);
  };
  button.addEventListener('click', load);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') load();
  });
  if (document.visibilityState === 'visible') load();
}

init();
