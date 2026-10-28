// @ts-nocheck -- ported JS assertions (node:assert); inputs are deliberately malformed.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
    normalizeDomain, hostMatchesDomain, urlMatchesDomains, unwrapPlaceholderUrl, checkRestorable,
    dedupKey, isInternalUrl, isBlankUrl,
} from '@/lib/url-utils';

describe('normalizeDomain', () => {
    it('strips scheme, path, port, wildcard and case', () => {
        assert.equal(normalizeDomain('https://GitHub.com/x'), 'github.com');
        assert.equal(normalizeDomain('  *.Example.org  '), 'example.org');
        assert.equal(normalizeDomain('.example.org'), 'example.org');
        assert.equal(normalizeDomain('localhost:8080/path?q=1'), 'localhost');
    });
    it('returns null for empty or non-string input', () => {
        for (const v of ['', '   ', null, undefined, 5, 'https://']) assert.equal(normalizeDomain(v), null);
    });
});

describe('hostMatchesDomain', () => {
    it('matches exact host and subdomains', () => {
        assert.ok(hostMatchesDomain('github.com', 'github.com'));
        assert.ok(hostMatchesDomain('gist.github.com', 'github.com'));
        assert.ok(hostMatchesDomain('GitHub.com.', 'github.com'));
    });
    it('does not match look-alike suffixes', () => {
        assert.equal(hostMatchesDomain('notgithub.com', 'github.com'), false);
        assert.equal(hostMatchesDomain('github.com.evil.io', 'github.com'), false);
    });
    it('is false for missing input', () => {
        assert.equal(hostMatchesDomain('', 'a.com'), false);
        assert.equal(hostMatchesDomain('a.com', ''), false);
    });
    it('urlMatchesDomains: empty list matches all, invalid URL never matches', () => {
        assert.ok(urlMatchesDomains('https://x.com', []));
        assert.ok(urlMatchesDomains('https://gist.github.com/z', ['github.com']));
        assert.equal(urlMatchesDomains('https://notgithub.com/', ['github.com']), false);
        assert.equal(urlMatchesDomains('not a url', ['github.com']), false);
    });
});

describe('unwrapPlaceholderUrl', () => {
    it('unwraps Great Suspender hash form (#...&uri=)', () => {
        assert.equal(
            unwrapPlaceholderUrl('chrome-extension://abc/suspended.html#ttl=Title&pos=0&uri=https://example.com/a'),
            'https://example.com/a',
        );
    });
    it('keeps an unencoded query string inside uri= (regression)', () => {
        assert.equal(
            unwrapPlaceholderUrl('chrome-extension://abc/suspended.html#ttl=x&pos=0&uri=https://example.com/a?b=1&c=2'),
            'https://example.com/a?b=1&c=2',
        );
    });
    it('unwraps ?url= forms, including moz-extension', () => {
        assert.equal(
            unwrapPlaceholderUrl('chrome-extension://abc/park.html?url=https%3A%2F%2Fexample.com%2Fp'),
            'https://example.com/p',
        );
        assert.equal(
            unwrapPlaceholderUrl('moz-extension://abc/x.html?url=https%3A%2F%2Fexample.com%2F'),
            'https://example.com/',
        );
    });
    it('unwraps our own lazy page', () => {
        assert.equal(
            unwrapPlaceholderUrl(`chrome-extension://abc/lazy/lazy.html?url=${encodeURIComponent('https://a.com/x?y=1')}&title=T`),
            'https://a.com/x?y=1',
        );
    });
    it('leaves normal and non-http-target URLs alone', () => {
        assert.equal(unwrapPlaceholderUrl('https://a.com/?url=https://b.com'), 'https://a.com/?url=https://b.com');
        const evil = 'chrome-extension://abc/p.html?url=javascript:alert(1)';
        assert.equal(unwrapPlaceholderUrl(evil), evil);
        assert.equal(unwrapPlaceholderUrl(undefined), undefined);
    });
});

describe('checkRestorable', () => {
    const ok = { ok: true };
    it('allows http(s) everywhere', () => {
        for (const f of ['chromium', 'gecko', 'webkit', 'unknown']) {
            assert.deepEqual(checkRestorable('https://a.com/', f), ok);
            assert.deepEqual(checkRestorable('http://a.com/', f), ok);
        }
    });
    it('rejects empty and invalid URLs', () => {
        assert.deepEqual(checkRestorable('', 'chromium'), { ok: false, reason: 'empty-url' });
        assert.deepEqual(checkRestorable(undefined, 'chromium'), { ok: false, reason: 'empty-url' });
        assert.deepEqual(checkRestorable('nope', 'chromium'), { ok: false, reason: 'invalid-url' });
    });
    it('rejects javascript: and data: as unsafe in every family', () => {
        for (const f of ['chromium', 'gecko']) {
            assert.deepEqual(checkRestorable('javascript:alert(1)', f), { ok: false, reason: 'unsafe-scheme' });
            assert.deepEqual(checkRestorable('data:text/html,hi', f), { ok: false, reason: 'unsafe-scheme' });
        }
    });
    it('file: only restorable on chromium', () => {
        assert.deepEqual(checkRestorable('file:///tmp/a.html', 'chromium'), ok);
        assert.deepEqual(checkRestorable('file:///tmp/a.html', 'gecko'), { ok: false, reason: 'file-url-blocked' });
    });
    it('internal pages depend on the family', () => {
        assert.deepEqual(checkRestorable('chrome://settings/', 'chromium'), ok);
        assert.deepEqual(checkRestorable('edge://settings/', 'chromium'), ok);
        assert.deepEqual(checkRestorable('chrome://settings/', 'gecko'), { ok: false, reason: 'internal-page' });
        assert.deepEqual(checkRestorable('about:config', 'gecko'), { ok: false, reason: 'internal-page' });
        assert.deepEqual(checkRestorable('moz-extension://x/y.html', 'chromium'), { ok: false, reason: 'internal-page' });
    });
    it('about:blank is always fine', () => {
        assert.deepEqual(checkRestorable('about:blank', 'gecko'), ok);
    });
});

describe('dedupKey', () => {
    it('ignores the hash and a trailing slash', () => {
        assert.equal(dedupKey('https://a.com/#x'), dedupKey('https://a.com'));
        assert.equal(dedupKey('https://a.com/p/#frag'), dedupKey('https://a.com/p'));
    });
    it('still distinguishes different paths and queries', () => {
        assert.notEqual(dedupKey('https://a.com/p'), dedupKey('https://a.com/q'));
        assert.notEqual(dedupKey('https://a.com/?x=1'), dedupKey('https://a.com/?x=2'));
    });
    it('returns raw input for unparsable URLs and "" for non-strings', () => {
        assert.equal(dedupKey('not a url'), 'not a url');
        assert.equal(dedupKey(null), '');
    });
});

describe('isInternalUrl / isBlankUrl', () => {
    it('classifies', () => {
        for (const u of ['chrome://x', 'about:blank', 'javascript:1', 'data:x', 'file:///a', 'moz-extension://a', '']) {
            assert.ok(isInternalUrl(u), u);
        }
        assert.equal(isInternalUrl('https://a.com'), false);
        assert.ok(isBlankUrl('chrome://newtab/'));
        assert.equal(isBlankUrl('https://a.com'), false);
    });
});
