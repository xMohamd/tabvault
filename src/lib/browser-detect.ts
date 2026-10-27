/**
 * Browser detection.
 *
 * Identity comes from the user agent (plus navigator.brave for Brave), but
 * capabilities are probed from the actual extension APIs, because a browser's
 * name says little about which APIs it ships.
 */
import { browser as ext } from 'wxt/browser';
import type { BrowserFamily } from './url-utils';

export type BrowserKey = 'chrome' | 'edge' | 'opera' | 'vivaldi' | 'brave' | 'firefox' | 'safari' | 'unknown';

export interface BrowserFeatures {
  tabGroups: boolean;
  groupColors: boolean;
  groupCollapse: boolean;
  bookmarks: boolean;
  downloads: boolean;
  discard: boolean;
  /** Firefox can create tabs that start discarded (lazy) with a title. */
  discardOnCreate: boolean;
  alarms: boolean;
  sessionStorage: boolean;
}

export interface BrowserInfo {
  key: BrowserKey;
  name: string;
  family: BrowserFamily;
  features: BrowserFeatures;
}

const BROWSERS: Array<{ key: BrowserKey; name: string; detect: (ua: string) => boolean }> = [
  // Order matters: the first match wins.
  { key: 'edge', name: 'Edge', detect: (ua) => /Edg\//.test(ua) },
  { key: 'opera', name: 'Opera', detect: (ua) => /OPR\//.test(ua) },
  { key: 'vivaldi', name: 'Vivaldi', detect: (ua) => /Vivaldi/.test(ua) },
  { key: 'firefox', name: 'Firefox', detect: (ua) => /Firefox\//.test(ua) },
  { key: 'chrome', name: 'Chrome', detect: (ua) => /Chrome\/|Chromium\//.test(ua) },
  { key: 'safari', name: 'Safari', detect: (ua) => /Safari\//.test(ua) && !/Chrome|Chromium/.test(ua) },
];

const FAMILY: Record<BrowserKey, BrowserFamily> = {
  chrome: 'chromium',
  edge: 'chromium',
  opera: 'chromium',
  vivaldi: 'chromium',
  brave: 'chromium',
  firefox: 'gecko',
  safari: 'webkit',
  unknown: 'unknown',
};

/** Probes what the running browser can actually do. */
export function probeFeatures(key: BrowserKey): BrowserFeatures {
  // Loosely typed on purpose: these APIs may be missing at runtime.
  const c = ext as unknown as Record<string, Record<string, unknown> | undefined>;
  const tabGroups = typeof c.tabs?.group === 'function' && !!(c.tabGroups as { update?: unknown } | undefined)?.update;
  return {
    tabGroups,
    groupColors: tabGroups && key !== 'safari',
    groupCollapse: tabGroups,
    bookmarks: typeof c.bookmarks?.create === 'function',
    downloads: typeof c.downloads?.download === 'function',
    discard: typeof c.tabs?.discard === 'function',
    discardOnCreate: key === 'firefox',
    alarms: typeof c.alarms?.create === 'function',
    sessionStorage: !!(c.storage as { session?: unknown } | undefined)?.session,
  };
}

function build(key: BrowserKey, name: string): BrowserInfo {
  return { key, name, family: FAMILY[key], features: probeFeatures(key) };
}

/** Synchronous detection. Cannot identify Brave (it hides behind a Chrome UA). */
export function detectBrowser(): BrowserInfo {
  const ua = globalThis.navigator?.userAgent ?? '';
  const match = BROWSERS.find((b) => b.detect(ua));
  return match ? build(match.key, match.name) : build('unknown', 'Unknown browser');
}

let cached: BrowserInfo | null = null;

/** Async detection that also recognises Brave. Cached per context. */
export async function detectBrowserAsync(): Promise<BrowserInfo> {
  if (cached) return cached;
  try {
    const brave = (globalThis.navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;
    if (await brave?.isBrave?.()) {
      cached = build('brave', 'Brave');
      return cached;
    }
  } catch {
    // Not Brave.
  }
  cached = detectBrowser();
  return cached;
}

/** TEST ONLY: forget the cached result. */
export function _resetBrowserCache(): void {
  cached = null;
}
