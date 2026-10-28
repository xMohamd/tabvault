/**
 * Typed wrapper over runtime.sendMessage for the popup -> background protocol.
 * Never throws: transport failures come back as { ok: false, error }.
 */
import { browser } from 'wxt/browser';
import type { MessageType, Protocol, Response } from './types';

const RETRY_DELAY_MS = 200;
/** Errors meaning the background wasn't reachable, so the message was never handled. */
const NOT_DELIVERED = /Receiving end does not exist|Could not establish connection/i;

export async function send<K extends MessageType>(
  type: K,
  payload: Omit<Protocol[K]['req'], never> = {} as Protocol[K]['req'],
): Promise<Response<K>> {
  const attempt = () => browser.runtime.sendMessage({ type, ...payload }) as Promise<Response<K> | undefined>;
  try {
    let reply: Response<K> | undefined;
    try {
      reply = await attempt();
    } catch (error) {
      // A cold background may not be listening yet; retrying is safe because it never ran.
      if (!NOT_DELIVERED.test(String((error as Error)?.message ?? error))) throw error;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      reply = await attempt();
    }
    return reply ?? ({ ok: false, error: 'No response from the background.' } as Response<K>);
  } catch (error) {
    return { ok: false, error: (error as Error)?.message ?? String(error) } as Response<K>;
  }
}
