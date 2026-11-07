import { describe, expect, it } from 'vitest';
import { emptyBackup, type Backup, type BackupTab } from '../src/lib/schema';
import { backupFromResults, mergeSearchResults, searchBackups, type SearchInput } from '../src/lib/snapshot-search';

const tab = (title: string, url: string, extra: Partial<BackupTab> = {}): BackupTab => ({ title, url, pinned: false, ...extra });

function backup(tabs: BackupTab[] = [], bookmarks: Backup['bookmarks'] = []): Backup {
  const data = emptyBackup();
  if (tabs.length) data.windows.push({ ungroupedTabs: tabs, groups: [] });
  data.bookmarks = bookmarks;
  return data;
}
const source = (id: string, date: string | null, data: Backup): SearchInput => ({ id, label: `label ${id}`, date, data });

describe('searchBackups matching', () => {
  const data = backup([tab('GitHub Pull Requests', 'https://github.com/pulls'), tab('Docs', 'https://docs.example/guide')]);

  it('needs every word, in the title or the address, ignoring case', () => {
    const run = (q: string) => searchBackups([source('a', '2025-01-01', data)], q).results.map((r) => r.title);
    expect(run('github')).toEqual(['GitHub Pull Requests']);
    expect(run('PULL github.com')).toEqual(['GitHub Pull Requests']); // one word in the title, one in the url
    expect(run('github docs')).toEqual([]);
    expect(run('  guide  ')).toEqual(['Docs']);
  });

  it('returns nothing for an empty or blank query', () => {
    expect(searchBackups([source('a', null, data)], '')).toEqual({ results: [], total: 0 });
    expect(searchBackups([source('a', null, data)], '   \t')).toEqual({ results: [], total: 0 });
  });

  it('filters by kind', () => {
    const both = backup([tab('Example tab', 'https://example.com/t')], [{ title: 'Example mark', url: 'https://example.com/b' }]);
    const run = (kinds: Array<'tab' | 'bookmark'>) => searchBackups([source('a', null, both)], 'example', { kinds }).results.map((r) => r.kind);
    expect(run(['tab'])).toEqual(['tab']);
    expect(run(['bookmark'])).toEqual(['bookmark']);
    expect(run(['tab', 'bookmark']).sort()).toEqual(['bookmark', 'tab']);
  });
});

describe('searchBackups deduplication', () => {
  it('lists a page once with every source, newest first, and takes details from the newest', () => {
    const old = backup([tab('Old title', 'https://x.example/page#a')]);
    const mid = backup([tab('Mid title', 'https://x.example/page/')]); // same dedupKey
    const recent = backup([tab('New title', 'https://x.example/page#b', { pinned: true })]);
    const { results, total } = searchBackups(
      [source('old', '2025-01-01T00:00:00Z', old), source('new', '2025-03-01T00:00:00Z', recent), source('mid', '2025-02-01T00:00:00Z', mid)],
      'x.example',
    );
    expect(total).toBe(1);
    expect(results).toHaveLength(1);
    const [r] = results;
    expect(r?.title).toBe('New title');
    expect(r?.pinned).toBe(true);
    expect(r?.key).toBe('https://x.example/page');
    expect(r?.sources.map((s) => s.id)).toEqual(['new', 'mid', 'old']);
    expect(r?.latest).toBe('2025-03-01T00:00:00Z');
  });

  it('lists a source once even when the page is open twice in it', () => {
    const twice = backup([tab('A', 'https://a.example/'), tab('A again', 'https://a.example/')]);
    const { results } = searchBackups([source('s', '2025-01-01', twice)], 'a.example');
    expect(results).toHaveLength(1);
    expect(results[0]?.sources).toHaveLength(1);
  });

  it('keeps a tab and a bookmark of the same page apart', () => {
    const both = backup([tab('P', 'https://p.example/')], [{ title: 'P', url: 'https://p.example/' }]);
    expect(searchBackups([source('s', null, both)], 'p.example').results).toHaveLength(2);
  });

  it('takes group and container from the newest source', () => {
    const grouped = emptyBackup();
    grouped.windows.push({ ungroupedTabs: [], groups: [{ title: 'Work', color: 'blue', collapsed: false, tabs: [tab('T', 'https://t.example/', { container: { name: 'Shop' } })] }] });
    const plain = backup([tab('T', 'https://t.example/')]);
    const { results } = searchBackups([source('old', '2025-01-01', grouped), source('new', '2025-02-01', plain)], 't.example');
    expect(results[0]?.group).toBeUndefined();
    const reverse = searchBackups([source('old', '2025-01-01', plain), source('new', '2025-02-01', grouped)], 't.example');
    expect(reverse.results[0]?.group).toEqual({ title: 'Work', color: 'blue' });
    expect(reverse.results[0]?.container).toEqual({ name: 'Shop' });
  });
});

describe('searchBackups order and limit', () => {
  it('sorts by newest source, then title', () => {
    const a = backup([tab('Zebra', 'https://z.example/'), tab('Apple', 'https://a.example/'), tab('Mango', 'https://m.example/')]);
    const b = backup([tab('Banana', 'https://b.example/')]);
    const { results } = searchBackups([source('a', '2025-01-01', a), source('b', '2025-02-01', b)], 'example');
    expect(results.map((r) => r.title)).toEqual(['Banana', 'Apple', 'Mango', 'Zebra']);
  });

  it('caps the list at the limit but reports the total', () => {
    const many = backup(Array.from({ length: 30 }, (_, i) => tab(`Page ${String(i).padStart(2, '0')}`, `https://e.example/${i}`)));
    const { results, total } = searchBackups([source('a', null, many)], 'page', { limit: 10 });
    expect(results).toHaveLength(10);
    expect(total).toBe(30);
    expect(searchBackups([source('a', null, many)], 'page').results).toHaveLength(30);
  });
});

describe('searchBackups bookmarks', () => {
  const tree: Backup['bookmarks'] = [
    {
      title: '',
      children: [
        { title: 'Bookmarks bar', children: [{ title: 'Dev', children: [{ title: 'MDN', url: 'https://developer.mozilla.org/' }] }, { title: 'Top', url: 'https://top.example/' }] },
        { title: 'Other bookmarks', children: [{ title: 'Misc', url: 'https://misc.example/' }] },
      ],
    },
  ];

  it('gives the folder path from the top, without the tree root', () => {
    const { results } = searchBackups([source('s', null, backup([], tree))], 'e', { kinds: ['bookmark'] });
    const path = (title: string) => results.find((r) => r.title === title)?.folderPath;
    expect(path('MDN')).toEqual(['Bookmarks bar', 'Dev']);
    expect(path('Top')).toEqual(['Bookmarks bar']);
    expect(path('Misc')).toEqual(['Other bookmarks']);
  });

  it('keeps a titled top-level folder (a tree without a root node)', () => {
    const flat: Backup['bookmarks'] = [{ title: 'Bookmarks bar', children: [{ title: 'Hit', url: 'https://hit.example/' }] }];
    expect(searchBackups([source('s', null, backup([], flat))], 'hit').results[0]?.folderPath).toEqual(['Bookmarks bar']);
  });
});

describe('mergeSearchResults', () => {
  it('combines sources by kind and key and prefers the newer details', () => {
    const one = searchBackups([source('a', '2025-01-01', backup([tab('Old', 'https://m.example/')]))], 'm.example').results;
    const two = searchBackups([source('file', '2025-05-01', backup([tab('Newer', 'https://m.example/')]))], 'm.example').results;
    const merged = mergeSearchResults([one, two]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe('Newer');
    expect(merged[0]?.sources.map((s) => s.id)).toEqual(['file', 'a']);
  });
});

describe('backupFromResults', () => {
  it('builds one window with groups recreated by title and color, pinned tabs kept', () => {
    const data = emptyBackup();
    data.windows.push({
      ungroupedTabs: [tab('Plain', 'https://plain.example/'), tab('Pin', 'https://pin.example/', { pinned: true })],
      groups: [
        { title: 'Work', color: 'blue', collapsed: false, tabs: [tab('W1', 'https://w1.example/'), tab('W2', 'https://w2.example/')] },
        { title: 'Work', color: 'red', collapsed: false, tabs: [tab('R', 'https://r.example/')] },
      ],
    });
    data.bookmarks = [{ title: 'Bar', children: [{ title: 'BM', url: 'https://bm.example/' }] }];
    const { results } = searchBackups([source('s', null, data)], 'example');
    const out = backupFromResults(results, 'Restored from search');
    expect(out.windows).toHaveLength(1);
    expect(out.windows[0]?.ungroupedTabs.map((x) => [x.title, x.pinned]).sort()).toEqual([['Pin', true], ['Plain', false]]);
    expect(out.windows[0]?.groups.map((g) => [g.title, g.color, g.tabs.length]).sort()).toEqual([['Work', 'blue', 2], ['Work', 'red', 1]]);
    expect(out.bookmarks).toEqual([{ title: 'Restored from search', children: [{ title: 'BM', url: 'https://bm.example/' }] }]);
  });

  it('leaves out windows and bookmarks that were not chosen', () => {
    const out = backupFromResults([], 'x');
    expect(out.windows).toEqual([]);
    expect(out.bookmarks).toEqual([]);
  });
});

describe('searchBackups performance', () => {
  // Wall-clock timing flakes when the whole suite runs in parallel, so the default bound only
  // catches order-of-magnitude regressions (e.g. an accidental O(n²)); PERF=1 enforces the target.
  const PERF_BUDGET_MS = process.env.PERF ? 300 : 1500;

  it('searches 50 snapshots of 500 tabs and 100 bookmarks fast (300 ms target)', () => {
    const sources: SearchInput[] = Array.from({ length: 50 }, (_, s) => {
      const tabs = Array.from({ length: 500 }, (_, i) => tab(`Site ${i % 400} page`, `https://site${i % 400}.example.com/path/${i % 400}?q=${s % 5}`));
      const marks = Array.from({ length: 100 }, (_, i) => ({ title: `Mark ${i}`, url: `https://mark${i}.example.org/` }));
      return source(`s${s}`, new Date(2025, 0, 1 + s).toISOString(), backup(tabs, [{ title: 'Bar', children: marks }]));
    });
    // Best of three: the suite runs in parallel with others, and one slow slice says little about the code.
    const best = (query: string) => {
      let fastest = Infinity;
      let last = searchBackups(sources, query);
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        last = searchBackups(sources, query);
        fastest = Math.min(fastest, performance.now() - started);
      }
      return { fastest, ...last };
    };
    const { fastest, results, total } = best('example page');
    expect(total).toBeGreaterThan(400);
    expect(results.length).toBeLessThanOrEqual(500);
    expect(fastest).toBeLessThan(PERF_BUDGET_MS);
    // A query matching everything is the worst case for the bookkeeping.
    expect(best('e').fastest).toBeLessThan(PERF_BUDGET_MS);
  });
});
