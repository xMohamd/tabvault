/**
 * Theme and view-mode bootstrap.
 *
 * `initTheme()` must run before React renders (main.tsx imports and calls it
 * first), so the stored preference and the `is-tab-view` class are on <html>
 * before the first paint. With no `data-theme` attribute the stylesheet already
 * follows the OS via prefers-color-scheme, so there is no flash in that case.
 */

export const THEME_STORAGE_KEY = 'tabvault:theme';
const THEME_ATTRIBUTE = 'data-theme';
const LIGHT_MEDIA_QUERY = '(prefers-color-scheme: light)';

export type ThemePreference = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

const PREFERENCES: readonly ThemePreference[] = ['dark', 'light', 'system'];
const isPreference = (value: unknown): value is ThemePreference => PREFERENCES.includes(value as ThemePreference);

export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(stored) ? stored : 'system';
  } catch (error) {
    // Storage can be unavailable (disabled or partitioned); "system" is a safe default.
    console.warn('[TabVault] Could not read theme preference', error);
    return 'system';
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.(LIGHT_MEDIA_QUERY).matches ? 'light' : 'dark';
}

export function resolveTheme(preference: ThemePreference = readPreference()): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

function apply(preference: ThemePreference): void {
  document.documentElement.setAttribute(THEME_ATTRIBUTE, resolveTheme(preference));
}

export function setPreference(preference: ThemePreference): ThemePreference {
  const next = isPreference(preference) ? preference : 'system';
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch (error) {
    console.warn('[TabVault] Could not persist theme preference', error);
  }
  apply(next);
  return next;
}

/** Flips between light and dark, pinning the choice so it stops tracking the OS. */
export function toggleTheme(): ResolvedTheme {
  setPreference(resolveTheme() === 'dark' ? 'light' : 'dark');
  return resolveTheme();
}

/** Full-tab view is popup.html?view=tab; tracked here so the class lands before first paint. */
export function isTabView(): boolean {
  return new URLSearchParams(location.search).get('view') === 'tab';
}

/** Applies theme and view class and keeps following the OS while the preference is "system". */
export function initTheme(): void {
  apply(readPreference());
  if (isTabView()) document.documentElement.classList.add('is-tab-view');
  window.matchMedia?.(LIGHT_MEDIA_QUERY).addEventListener?.('change', () => {
    const preference = readPreference();
    if (preference === 'system') apply(preference);
  });
}
