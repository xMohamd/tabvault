/**
 * Structured logger: console output, an in-memory history for diagnostics,
 * and listeners. A throwing listener never breaks logging.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  action: string;
  data: unknown;
  error: { message: string; stack?: string } | null;
}

const MAX_HISTORY = 1000;

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  if (typeof error === 'string') return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

export class Logger {
  private logs: LogEntry[] = [];
  private listeners: Array<(entry: LogEntry) => void> = [];

  log(level: LogLevel, action: string, data: unknown = {}, error: unknown = null): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      action,
      data,
      error: error ? serializeError(error) : null,
    };

    const prefix = `[TabVault] [${level}] ${action}`;
    const args = error ? [prefix, data, error] : [prefix, data];
    const sink = { DEBUG: console.debug, INFO: console.info, WARN: console.warn, ERROR: console.error }[level];
    sink(...args);

    this.logs.push(entry);
    if (this.logs.length > MAX_HISTORY) this.logs.shift();

    for (const cb of this.listeners) {
      try {
        cb(entry);
      } catch (e) {
        console.error('[TabVault] log listener failed', e);
      }
    }
  }

  debug(action: string, data?: unknown, err?: unknown) { this.log('DEBUG', action, data, err); }
  info(action: string, data?: unknown, err?: unknown) { this.log('INFO', action, data, err); }
  warn(action: string, data?: unknown, err?: unknown) { this.log('WARN', action, data, err); }
  error(action: string, data?: unknown, err?: unknown) { this.log('ERROR', action, data, err); }

  /** @returns unsubscribe */
  onLog(callback: (entry: LogEntry) => void): () => void {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((cb) => cb !== callback);
    };
  }

  getLogs(): LogEntry[] {
    return this.logs.slice();
  }
}

export const logger = new Logger();
