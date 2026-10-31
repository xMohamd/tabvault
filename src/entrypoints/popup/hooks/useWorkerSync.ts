import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { detectBrowser, type BrowserInfo } from '@/lib/browser-detect';
import { send } from '@/lib/messaging';
import type { ImportState } from '@/lib/types';

interface Handlers {
  /** Called with the state from GET_STATE and every IMPORT_STATE broadcast. */
  onImportState: (state: ImportState) => void;
  /** GET_STATE failed. */
  onError: (message: string) => void;
  /** Called once after GET_STATE with whether a restore is already running. */
  onLoaded: (running: boolean) => void;
}

/**
 * Connects the popup to the background: asks for the current state on mount (so
 * reopening shows progress/results) and follows IMPORT_STATE broadcasts.
 * Returns the browser info, refined by the worker's answer (it can recognise Brave).
 */
export function useWorkerSync(handlers: Handlers): BrowserInfo {
  const [info, setInfo] = useState<BrowserInfo>(() => detectBrowser());
  // Handlers change every render; the subscriptions must not.
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    const listener = (message: unknown) => {
      const m = message as { type?: string; state?: ImportState } | null;
      if (m?.type === 'IMPORT_STATE' && m.state) latest.current.onImportState(m.state);
    };
    browser.runtime.onMessage.addListener(listener);

    let cancelled = false;
    void send('GET_STATE').then((reply) => {
      if (cancelled) return;
      if (!reply.ok) {
        latest.current.onError(reply.error);
        return;
      }
      if (reply.browser) setInfo(reply.browser);
      if (reply.importState) latest.current.onImportState(reply.importState);
      latest.current.onLoaded(reply.importState?.status === 'running' || reply.importState?.status === 'cancelling');
    });

    return () => {
      cancelled = true;
      browser.runtime.onMessage.removeListener(listener);
    };
  }, []);

  return info;
}
