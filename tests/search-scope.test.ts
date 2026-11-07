import { describe, expect, it } from 'vitest';
import { FILE_SOURCE_ID, isInScope, resolveScope, scopeSize, toggleAll, toggleSource } from '../src/lib/search-scope';

const sources = ['c', 'b', 'a']; // newest first
const set = (...ids: string[]) => new Set(ids);

describe('resolveScope', () => {
  it('keeps null (everything) and a real subset', () => {
    expect(resolveScope(null, sources)).toBeNull();
    expect(resolveScope(set('a', 'b'), sources)).toEqual(set('a', 'b'));
  });

  it('turns "every source" and "nothing left" into null', () => {
    expect(resolveScope(set('a', 'b', 'c'), sources)).toBeNull();
    expect(resolveScope(set('gone'), sources)).toBeNull(); // the only chosen backup was deleted
  });

  it('drops ids that no longer exist', () => {
    expect(resolveScope(set('a', 'gone'), sources)).toEqual(set('a'));
    expect(resolveScope(set('b', 'c', 'gone'), sources)).toEqual(set('b', 'c'));
    expect(resolveScope(set('a', FILE_SOURCE_ID), sources)).toEqual(set('a')); // file unloaded
  });
});

describe('scope helpers', () => {
  it('knows what is in scope and how many', () => {
    expect(isInScope(null, 'a')).toBe(true);
    expect(isInScope(set('a'), 'b')).toBe(false);
    expect(scopeSize(null, sources)).toBe(3);
    expect(scopeSize(set('a', 'b'), sources)).toBe(2);
  });

  it('unticks from "all" and ticks back to "all"', () => {
    const partial = toggleSource(null, sources, 'b', false);
    expect(partial).toEqual(set('a', 'c'));
    expect(toggleSource(partial, sources, 'b', true)).toBeNull();
  });

  it('never unticks the last source', () => {
    const one = toggleSource(set('a', 'b'), sources, 'b', false);
    expect(one).toEqual(set('a'));
    expect(toggleSource(one, sources, 'a', false)).toBe(one);
  });

  it('"all" ticks everything, or leaves only the newest', () => {
    expect(toggleAll(sources, true)).toBeNull();
    expect(toggleAll(sources, false)).toEqual(set('c'));
    expect(toggleAll([], false)).toBeNull();
  });
});
