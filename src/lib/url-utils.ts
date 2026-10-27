/**
 * URL helpers shared by export and import.
 * Pure functions, no extension APIs, so they are safe in any context.
 */

export type BrowserFamily = 'chromium' | 'gecko' | 'webkit' | 'unknown';

/** Schemes that belong to the browser itself or to an extension. */
const INTERNAL_PREFIXES = [
  'chrome://', 'chrome-untrusted://', 'chrome-search://', 'chrome-extension://',
  'edge://', 'brave://', 'opera://', 'vivaldi://', 'devtools://',
  'about:', 'moz-extension://', 'safari-web-extension://', 'resource://',
  'view-source:', 'blob:', 'data:', 'javascript:', 'file://', 'place:',
];

/** Internal pages that the given browser family can reopen with tabs.create. */
const REOPENABLE_INTERNAL: Record<BrowserFamily, string[]> = {
  chromium: ['chrome://', 'edge://', 'brave://', 'opera://', 'vivaldi://'],
  gecko: [],
  webkit: [],
  unknown: [],
};

/** Effectively blank pages: skipping them avoids restoring hundreds of empty tabs. */
const BLANK_URLS = new Set([
  'about:blank', 'about:newtab', 'about:home', 'chrome://newtab/', 'edge://newtab/',
  'chrome://new-tab-page/', 'opera://startpage/', 'vivaldi://startpage/', 'brave://newtab/',
]);

const WEB_URL = /^(https?|ftp|file):/i;
const isWebUrl = (value: unknown): value is string => typeof value === 'string' && WEB_URL.test(value);

export function isInternalUrl(url: unknown): boolean {
  if (typeof url !== 'string' || url === '') return true;
  const lower = url.toLowerCase();
  return INTERNAL_PREFIXES.some((p) => lower.startsWith(p));
}

export function isBlankUrl(url: unknown): boolean {
  return typeof url === 'string' && BLANK_URLS.has(url.toLowerCase());
}

/** Normalises a user-entered domain ("https://GitHub.com/x" -> "github.com"). */
export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '').replace(/^\./, '');
  value = value.split(/[/?#:]/)[0] ?? '';
  return value || null;
}

/** Exact host or any subdomain. "github.com" matches "gist.github.com", not "notgithub.com". */
export function hostMatchesDomain(hostname: string, domain: string): boolean {
  if (!hostname || !domain) return false;
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === domain || host.endsWith(`.${domain}`);
}

export function urlMatchesDomains(url: string, domains: string[] | undefined): boolean {
  if (!domains?.length) return true;
  try {
    const { hostname } = new URL(url);
    return domains.some((d) => hostMatchesDomain(hostname, d));
  } catch {
    return false;
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Recovers the real URL from tab-suspender / lazy-loader placeholder pages,
 * including this extension's own lazy page. Returns the input when nothing matches.
 */
export function unwrapPlaceholderUrl(url: string): string {
  if (typeof url !== 'string') return url;
  const lower = url.toLowerCase();
  const isExtensionPage =
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('moz-extension://') ||
    lower.startsWith('safari-web-extension://');
  if (!isExtensionPage) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  // The Great Suspender / Marvellous Suspender: suspended.html#ttl=..&pos=..&uri=<url>.
  // "uri" comes last and is NOT encoded, so the real URL may contain more "&";
  // take everything after it verbatim instead of letting URLSearchParams split it.
  const hash = parsed.hash.replace(/^#/, '');
  const rawMatch = /(?:^|&)uri=(.*)$/s.exec(hash);
  if (rawMatch?.[1]) {
    const raw = rawMatch[1];
    if (isWebUrl(raw)) return raw;
    const decoded = safeDecode(raw);
    if (isWebUrl(decoded)) return decoded;
  }

  const candidates: Array<string | null> = [];
  if (hash) candidates.push(new URLSearchParams(hash).get('url'));
  // Tab Suspender, Auto Tab Discard placeholders, our own lazy page: ?url=<encoded url>
  candidates.push(parsed.searchParams.get('url'), parsed.searchParams.get('uri'));
  return candidates.find(isWebUrl) ?? url;
}

export type RestoreFailureReason =
  | 'empty-url'
  | 'invalid-url'
  | 'file-url-blocked'
  | 'unsafe-scheme'
  | 'internal-page';

export type RestoreCheck = { ok: true } | { ok: false; reason: RestoreFailureReason };

/** Whether a URL can be reopened with tabs.create in the given browser family. */
export function checkRestorable(url: unknown, family: BrowserFamily): RestoreCheck {
  if (typeof url !== 'string' || url.trim() === '') return { ok: false, reason: 'empty-url' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  const scheme = parsed.protocol;
  if (scheme === 'http:' || scheme === 'https:') return { ok: true };
  if (scheme === 'file:') {
    return family === 'chromium' ? { ok: true } : { ok: false, reason: 'file-url-blocked' };
  }
  if (url === 'about:blank') return { ok: true };
  const lower = url.toLowerCase();
  if (REOPENABLE_INTERNAL[family].some((p) => lower.startsWith(p))) return { ok: true };
  if (scheme === 'javascript:' || scheme === 'data:' || scheme === 'blob:') {
    return { ok: false, reason: 'unsafe-scheme' };
  }
  return { ok: false, reason: 'internal-page' };
}

/** Stable key for duplicate detection: ignores the fragment and a trailing slash. */
export function dedupKey(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    u.hash = '';
    const s = u.toString();
    return s.endsWith('/') ? s.slice(0, -1) : s;
  } catch {
    return url;
  }
}
