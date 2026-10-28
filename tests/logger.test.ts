// @ts-nocheck -- ported JS assertions; the logger API itself is type-checked in src.
import { describe, it, beforeEach } from 'vitest';
import assert from 'node:assert/strict';

// Capture console calls before the logger is used; DEBUG=1 prints them as well.
const seen: Array<[string, unknown[]]> = [];
const real = { ...console };
for (const level of ['debug', 'info', 'warn', 'error', 'log'] as const) {
    console[level] = (...args: unknown[]) => {
        seen.push([level, args]);
        if (process.env.DEBUG) real[level](...args);
    };
}

import { Logger } from '@/lib/logger';

let logger: Logger;

describe('logger', () => {
    beforeEach(() => {
        seen.length = 0;
        logger = new Logger();
    });

    it('warn keeps the error argument (regression)', () => {
        const err = new Error('kaput');
        logger.warn('SOMETHING', { a: 1 }, err);
        const entry = logger.getLogs().at(-1);
        assert.equal(entry.level, 'WARN');
        assert.equal(entry.error.message, 'kaput');
        assert.ok(entry.error.stack);
        const [level, args] = seen.at(-1);
        assert.equal(level, 'warn');
        assert.equal(args.at(-1), err, 'error is passed to console.warn');
    });

    it('routes every level to the matching console method and records history', () => {
        logger.debug('D'); logger.info('I'); logger.warn('W'); logger.error('E');
        assert.deepEqual(seen.map(([l]) => l), ['debug', 'info', 'warn', 'error']);
        assert.deepEqual(logger.getLogs().map((e) => e.level), ['DEBUG', 'INFO', 'WARN', 'ERROR']);
        assert.equal(logger.getLogs().at(-1).error, null);
    });

    it('serialises string and non-Error errors', () => {
        logger.error('X', {}, 'text');
        logger.error('X', {}, { code: 5 });
        const [a, b] = logger.getLogs();
        assert.deepEqual(a.error, { message: 'text' });
        assert.deepEqual(b.error, { message: '{"code":5}' });
    });

    it('a throwing listener does not break logging or other listeners', () => {
        const got = [];
        logger.onLog(() => { throw new Error('listener boom'); });
        logger.onLog((e) => got.push(e.action));
        assert.doesNotThrow(() => logger.info('STILL_WORKS'));
        assert.deepEqual(got, ['STILL_WORKS']);
        assert.equal(logger.getLogs().at(-1).action, 'STILL_WORKS');
    });

    it('onLog returns an unsubscribe function', () => {
        const got = [];
        const off = logger.onLog((e) => got.push(e.action));
        logger.info('ONE');
        off();
        logger.info('TWO');
        assert.deepEqual(got, ['ONE']);
    });

    it('history is capped at 1000 entries and getLogs returns a copy', () => {
        for (let i = 0; i < 1005; i++) logger.debug(`E${i}`);
        const logs = logger.getLogs();
        assert.equal(logs.length, 1000);
        assert.equal(logs[0].action, 'E5');
        logs.length = 0;
        assert.equal(logger.getLogs().length, 1000);
    });
});
