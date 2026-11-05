/**
 * Saves JSON through the downloads API (used by Export, snapshot downloads and
 * automatic backup files). Chrome's service worker has no URL.createObjectURL, so it
 * gets a data: URL; Firefox's event page uses a blob URL.
 */
import { browser } from 'wxt/browser';
import { logger } from './logger';

export type SaveResult =
  | { ok: true; filename: string; downloadId: number }
  | { ok: false; error: string; cancelled?: boolean };

const BLOB_URL_LIFETIME_MS = 60_000;

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * @param filename relative to the Downloads folder; may contain a subfolder ("TabVault/x.json")
 * @param saveAs show the Save dialog
 */
export async function saveJsonFile(data: unknown, filename: string, { saveAs = false } = {}): Promise<SaveResult> {
  const json = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  let url: string;
  let revoke = () => {};
  if (typeof URL.createObjectURL === 'function') {
    url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    revoke = () => setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_LIFETIME_MS);
  } else {
    url = `data:application/json;base64,${utf8ToBase64(json)}`;
  }

  try {
    const downloadId = await browser.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' });
    return { ok: true, filename, downloadId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/cancel/i.test(message)) return { ok: false, cancelled: true, error: message };
    logger.error('DOWNLOAD_FAILED', { filename }, error);
    return { ok: false, error: message };
  } finally {
    revoke();
  }
}
