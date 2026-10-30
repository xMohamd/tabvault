/**
 * Thin wrapper around browser.i18n.
 *
 * Messages live in public/_locales/<lang>/messages.json. Substitutions use the
 * browser's placeholder mechanism, so numbers and dates must be formatted
 * (Intl.*) by the caller before substitution. A missing key returns the key
 * itself, which makes gaps obvious in the UI.
 */
import { browser } from 'wxt/browser';

type Substitutions = string | number | Array<string | number>;

/** Loosely typed: WXT narrows getMessage keys to the known ones, we look up dynamically. */
interface I18nApi {
  getMessage(key: string, substitutions?: string | string[]): string;
  getUILanguage?(): string;
}

const api = (): I18nApi | undefined => (browser as unknown as { i18n?: I18nApi }).i18n;

/** The browser accepts only strings (max 9) as substitutions. */
function toSubstitutions(substitutions: Substitutions | undefined): string | string[] | undefined {
  if (substitutions === undefined || substitutions === null) return undefined;
  return Array.isArray(substitutions) ? substitutions.map(String) : String(substitutions);
}

function lookup(key: string, substitutions?: Substitutions): string {
  try {
    return api()?.getMessage(key, toSubstitutions(substitutions)) ?? '';
  } catch {
    return '';
  }
}

/** The localized message, or `key` when it is missing. */
export function t(key: string, substitutions?: Substitutions): string {
  return lookup(key, substitutions) || key;
}

let pluralRules: Intl.PluralRules | undefined;

function getPluralRules(): Intl.PluralRules {
  pluralRules ??= new Intl.PluralRules(api()?.getUILanguage?.() || undefined);
  return pluralRules;
}

/**
 * Plural-aware lookup. Browser messages have no plural syntax, so a plural
 * message is stored as `<key>_<category>` (zero/one/two/few/many/other), with
 * `<key>_other` as the required fallback.
 */
export function tp(key: string, count: number, substitutions?: Substitutions): string {
  const specific = lookup(`${key}_${getPluralRules().select(count)}`, substitutions);
  if (specific) return specific;
  return lookup(`${key}_other`, substitutions) || `${key}_other`;
}

/** TEST ONLY: forget the cached plural rules (the UI language may change between tests). */
export function _resetI18nCache(): void {
  pluralRules = undefined;
}
