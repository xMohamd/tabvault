// @ts-nocheck -- ported JS assertions (node:assert); inputs are deliberately malformed.
import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
    normalizeBackup, BackupFormatError, orderedWindowTabs, countTabs, countBookmarks,
    normalizeColor, emptyBackup, SCHEMA_VERSION,
} from '@/lib/schema';

describe('normalizeBackup', () => {
    it('rejects non-objects', () => {
        for (const bad of [null, undefined, 5, 'x', [], true]) {
            assert.throws(() => normalizeBackup(bad), BackupFormatError);
        }
    });

    it('rejects objects without windows or bookmarks', () => {
        assert.throws(() => normalizeBackup({}), BackupFormatError);
        assert.throws(() => normalizeBackup({ windows: 'x', bookmarks: {} }), BackupFormatError);
    });

    it('accepts bookmarks-only and windows-only backups', () => {
        assert.equal(normalizeBackup({ bookmarks: [] }).data.windows.length, 0);
        assert.equal(normalizeBackup({ windows: [] }).data.bookmarks.length, 0);
    });

    it('drops invalid tabs and counts them', () => {
        const { data, warnings } = normalizeBackup({
            windows: [{
                ungroupedTabs: [{ url: 'https://a.com' }, { url: '' }, { url: '   ' }, { title: 'x' }, null, 5],
                groups: [{ title: 'G', tabs: [{ url: 'https://b.com' }, { url: 7 }] }],
            }],
        });
        assert.equal(warnings.invalidTabs, 6);
        assert.equal(countTabs(data), 2);
    });

    it('drops empty windows and groups, counts invalid windows', () => {
        const { data, warnings } = normalizeBackup({
            windows: [null, { ungroupedTabs: [], groups: [{ tabs: [] }] }, { ungroupedTabs: [{ url: 'https://a.com' }] }],
        });
        assert.equal(data.windows.length, 1);
        assert.equal(warnings.invalidWindows, 1);
    });

    it('flags a newer major schema version', () => {
        const { warnings } = normalizeBackup({ schemaVersion: '2.0', windows: [] });
        assert.equal(warnings.newerSchema, true);
        assert.equal(normalizeBackup({ schemaVersion: '1.1', windows: [] }).warnings.newerSchema, false);
        assert.equal(normalizeBackup({ windows: [] }).data.schemaVersion, '1.0', 'missing version defaults to 1.0');
    });

    it('normalises colors, states, layout and optional tab fields', () => {
        const { data } = normalizeBackup({
            windows: [{
                state: 'weird', left: 1.6, width: 'x', focused: true,
                tabs: [{ url: ' https://a.com ', index: 2, active: true, pinned: true, favIconUrl: 'x', metadata: { a: 1 } }],
                groups: [{ title: 5, color: 'nope', collapsed: 'yes', tabs: [{ url: 'https://b.com' }] }],
            }],
        });
        const w = data.windows[0];
        assert.equal(w.state, undefined);
        assert.equal(w.left, 2);
        assert.equal(w.width, undefined);
        assert.equal(w.focused, true);
        assert.deepEqual(w.ungroupedTabs[0], {
            url: 'https://a.com', title: '', pinned: true, index: 2, active: true, favIconUrl: 'x', metadata: { a: 1 },
        });
        assert.deepEqual(
            { title: w.groups[0].title, color: w.groups[0].color, collapsed: w.groups[0].collapsed },
            { title: '', color: 'grey', collapsed: false },
        );
    });

    it('keeps only known bookmark keys and drops invalid nodes', () => {
        const { data, warnings } = normalizeBackup({
            bookmarks: [{ id: '0', title: 'r', evil: 1, children: [{ id: '1', url: 'https://a.com', syncing: true, dateAdded: 5 }, null, 'x'] }],
        });
        const [child] = data.bookmarks[0].children;
        assert.equal(data.bookmarks[0].children.length, 1);
        assert.equal(child.syncing, undefined);
        assert.equal(data.bookmarks[0].evil, undefined);
        assert.equal(child.dateAdded, 5);
        assert.equal(warnings.invalidBookmarks, 2);
    });
});

describe('orderedWindowTabs', () => {
    const t = (url, index, pinned) => ({ url, index, pinned });

    it('interleaves grouped and ungrouped tabs by index', () => {
        const win = {
            ungroupedTabs: [t('a', 0), t('d', 3)],
            groups: [{ tabs: [t('b', 1), t('c', 2)] }],
        };
        const out = orderedWindowTabs(win);
        assert.deepEqual(out.map((e) => e.tab.url), ['a', 'b', 'c', 'd']);
        assert.deepEqual(out.map((e) => e.groupIndex), [-1, 0, 0, -1]);
    });

    it('puts pinned tabs first regardless of index', () => {
        const win = { ungroupedTabs: [t('a', 0), t('p', 5, true)], groups: [{ tabs: [t('b', 1)] }] };
        assert.deepEqual(orderedWindowTabs(win).map((e) => e.tab.url), ['p', 'a', 'b']);
    });

    it('falls back to ungrouped-then-groups when any index is missing', () => {
        const win = { ungroupedTabs: [{ url: 'u' }], groups: [{ tabs: [t('g', 0)] }] };
        assert.deepEqual(orderedWindowTabs(win).map((e) => e.tab.url), ['u', 'g']);
    });

    it('handles an empty window', () => {
        assert.deepEqual(orderedWindowTabs({}), []);
    });
});

describe('counting and helpers', () => {
    it('countBookmarks counts only URL nodes', () => {
        assert.equal(countBookmarks([{ children: [{ url: 'x' }, { children: [{ url: 'y' }] }] }]), 2);
        assert.equal(countBookmarks(undefined), 0);
    });
    it('countTabs tolerates bad input', () => {
        assert.equal(countTabs(null), 0);
        assert.equal(countTabs({ windows: [{ ungroupedTabs: [{}], groups: [{ tabs: [{}, {}] }] }] }), 3);
    });
    it('normalizeColor', () => {
        assert.equal(normalizeColor('blue'), 'blue');
        assert.equal(normalizeColor('mauve'), 'grey');
    });
    it('emptyBackup uses the current schema', () => {
        const b = emptyBackup({ browser: 'x' });
        assert.equal(b.schemaVersion, SCHEMA_VERSION);
        assert.deepEqual([b.windows, b.bookmarks, b.source], [[], [], { browser: 'x' }]);
    });
});

describe('countBookmarklets', () => {
    it('counts javascript: bookmarks in nested trees', async () => {
        const { countBookmarklets } = await import('@/lib/schema');
        const tree = [{ title: '', children: [
            { title: 'a', url: 'javascript:1' },
            { title: 'f', children: [{ title: 'b', url: 'JAVASCRIPT:2' }, { title: 'c', url: 'https://x' }] },
        ] }];
        assert.equal(countBookmarklets(tree), 2);
        assert.equal(countBookmarklets(null), 0);
    });
});
