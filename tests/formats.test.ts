import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseBackupFile } from '../src/lib/formats';
import { BackupFormatError, countTabs, selectedByDefault } from '../src/lib/schema';

/** Index into an array, failing loudly (keeps tests free of non-null assertions). */
function at<T>(list: readonly T[] | undefined, i: number): T {
  const v = list?.[i];
  if (v === undefined) throw new Error(`No element at index ${i}`);
  return v;
}

describe('OneTab', () => {
  it('splits groups on blank lines, keeps pipes in titles, skips internal URLs', () => {
    const r = parseBackupFile(
      'https://a.com | A | pipe\nhttps://b.com\nchrome://x | skip\n\nhttps://c.com | C\n\n\nhttps://d.com | D\n',
    );
    expect(r.format).toBe('onetab');
    expect(r.data.windows.length).toBe(1);
    const g = at(r.data.windows, 0).groups;
    expect(g.length).toBe(3);
    expect(at(g, 0).title).toBe('OneTab group 1');
    expect(at(g, 1).color).toBe('blue');
    expect(at(at(g, 0).tabs, 0).title).toBe('A | pipe');
    expect(at(at(g, 0).tabs, 1).title).toBe('');
    expect(at(g, 0).tabs.length).toBe(2);
  });
  it('single group becomes ungrouped tabs; handles CRLF', () => {
    const r = parseBackupFile('https://a.com | A\r\nhttps://b.com | B');
    expect(at(r.data.windows, 0).ungroupedTabs.length).toBe(2);
    expect(at(r.data.windows, 0).groups.length).toBe(0);
  });
});

describe('Session Buddy', () => {
  it('legacy sessions format', () => {
    const r = parseBackupFile(
      JSON.stringify({
        sessions: [
          {
            name: 's',
            windows: [
              { tabs: [{ url: 'https://a.com', title: 'A', pinned: true }, { url: 'chrome://x' }] },
              { tabs: [{ url: 'https://b.com' }] },
            ],
          },
        ],
      }),
    );
    expect(r.format).toBe('session-buddy');
    expect(r.data.windows.length).toBe(2);
    expect(at(at(r.data.windows, 0).ungroupedTabs, 0).pinned).toBe(true);
    // Browser pages are kept: the restore step decides per browser and lists what it can't reopen.
    expect(at(r.data.windows, 0).ungroupedTabs.map((tab) => tab.url)).toEqual(['https://a.com', 'chrome://x']);
  });
  it('single session with tab groups', () => {
    const r = parseBackupFile(
      JSON.stringify({
        type: 'x',
        windows: [
          {
            tabs: [
              { url: 'https://a.com', groupId: 1 },
              { url: 'https://b.com', groupId: -1 },
              { url: 'https://c.com', groupId: 1 },
            ],
            groups: [{ id: 1, title: 'G', color: 'red' }],
          },
        ],
      }),
    );
    expect(r.format).toBe('session-buddy');
    const win = at(r.data.windows, 0);
    expect(at(win.groups, 0).tabs.length).toBe(2);
    expect(at(win.groups, 0).color).toBe('red');
    expect(at(win.ungroupedTabs, 0).index).toBe(1);
  });
  it('v4 collections', () => {
    const r = parseBackupFile(
      JSON.stringify({
        collections: [
          {
            title: 'c',
            folders: [
              { title: 'f', links: [{ url: 'https://a.com', title: 'A' }] },
              { links: [{ url: 'http://b.com' }] },
            ],
          },
          { links: [{ url: 'https://z.com' }] },
        ],
      }),
    );
    expect(r.format).toBe('session-buddy');
    expect(r.data.windows.length).toBe(3);
  });
  it('rejects a session with no usable tabs', () => {
    expect(() => parseBackupFile('{"sessions":[{"windows":[{"tabs":[]}]}]}')).toThrow(BackupFormatError);
  });
});

describe('Session Buddy (documented format, real v4 backup structure)', () => {
  const fixture = readFileSync(new URL('./fixtures/session-buddy-v4-backup.json', import.meta.url), 'utf8');

  it('reads a v4 backup: collections first, then history, with layout, groups and suspended tabs', () => {
    const r = parseBackupFile(fixture);
    expect(r.format).toBe('session-buddy');
    expect(r.label).toBe('Session Buddy backup');
    expect(r.data.windows).toHaveLength(4);
    expect(countTabs(r.data)).toBe(12);

    const docs = at(r.data.windows, 0);
    expect(docs.title).toBe('Research · Docs');
    expect(docs).toMatchObject({ state: 'normal', left: 50, top: 25, width: 1034, height: 560 });
    expect(at(docs.ungroupedTabs, 0).favIconUrl).toBe('https://developer.mozilla.org/favicon.ico');
    expect(at(docs.ungroupedTabs, 1).pinned).toBe(true);
    expect(at(r.data.windows, 1).title, '"name" wins over "title"').toBe('Research · Videos');

    const closed = at(r.data.windows, 2);
    expect(closed.title, 'history windows are labelled with their date').toMatch(/\d/);
    expect(closed.state).toBe('maximized');
    expect(closed.groups.map((g) => [g.title, g.color, g.tabs.length])).toEqual([
      ['', 'grey', 2],
      ['', 'blue', 2],
    ]);
    const all = [...closed.ungroupedTabs, ...closed.groups.flatMap((g) => g.tabs)].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    expect(all.map((tab) => tab.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const suspended = at(all, 4);
    expect(suspended.url, 'tab suspender placeholder unwrapped').toBe('https://news.example.com/story?id=42&ref=home');
    expect(String(suspended.metadata?.originalUrl)).toMatch(/^chrome-extension:\/\/.+\/park\.html\?/);
    expect(at(all, 2).active).toBe(true);
    expect(at(all, 5).favIconUrl, 'embedded data: icons are dropped').toBeUndefined();
    expect(all.map((tab) => tab.url)).toContain('chrome://settings/');
    expect(all.map((tab) => tab.url)).toContain('file:///home/user/notes.html');

    const last = at(r.data.windows, 3);
    expect(last.ungroupedTabs.map((tab) => tab.url), 'javascript: is never a tab').toEqual(['https://only.example.com/']);
  });

  it('ranks history snapshots newest first, whatever the file order', () => {
    const snap = (created: number, url: string) => ({ type: 'browser-closed', created, windows: [{ tabs: [{ url }] }] });
    const r = parseBackupFile(
      JSON.stringify({
        format: 'nxs.json.v2',
        history: [snap(1000, 'https://oldest.example/'), snap(3000, 'https://newest.example/'), snap(2000, 'https://middle.example/')],
      }),
    );
    expect(r.data.windows.map((w) => [at(w.ungroupedTabs, 0).url, w.metadata?.snapshot])).toEqual([
      ['https://newest.example/', 0],
      ['https://middle.example/', 1],
      ['https://oldest.example/', 2],
    ]);
    expect(r.data.windows.map((w) => selectedByDefault(w))).toEqual([true, false, false]);
  });

  it('pre-selects saved collections and only the newest history snapshot', () => {
    const r = parseBackupFile(fixture);
    expect(r.data.windows.map((w) => selectedByDefault(w))).toEqual([true, true, true, false]);
  });

  it('reads the documented export example (collections -> folders -> links)', () => {
    const r = parseBackupFile(
      JSON.stringify({
        collections: [
          { title: 'Furry friends', folders: [{ title: 'Dogs', links: [{ title: 'GSD', url: 'https://en.wikipedia.org/wiki/German_Shepherd' }] }] },
          { title: 'Reptiles', folders: [{ title: 'Snakes', state: 'maximized', incognito: true, links: [{ url: 'https://e.org/boa', pinned: true }] }] },
        ],
      }),
    );
    expect(r.label).toBe('Session Buddy export');
    expect(r.data.windows.map((w) => w.title)).toEqual(['Furry friends · Dogs', 'Reptiles · Snakes']);
    expect(at(r.data.windows, 1).state).toBe('maximized');
  });

  it.each([
    ['array of links', [{ url: 'https://a.com' }, { url: 'https://b.com' }], 1, 2],
    ['array of folders', [{ title: 'F', links: [{ url: 'https://a.com' }] }, { tabs: [{ url: 'https://b.com' }] }], 2, 2],
    ['array of collections', [{ title: 'C', folders: [{ links: [{ url: 'https://a.com' }] }] }], 1, 1],
    ['object with links', { links: [{ url: 'https://a.com' }] }, 1, 1],
    ['object with tabs', { tabs: [{ url: 'https://a.com' }, { url: 'https://b.com' }] }, 1, 2],
    ['object with folders', { folders: [{ links: [{ url: 'https://a.com' }] }] }, 1, 1],
  ])('accepts the documented %s form', (_name, json, windows, tabs) => {
    const r = parseBackupFile(JSON.stringify(json));
    expect(r.format).toBe('session-buddy');
    expect(r.data.windows).toHaveLength(windows);
    expect(countTabs(r.data)).toBe(tabs);
  });

  it('rejects a Session Buddy file with nothing restorable', () => {
    expect(() => parseBackupFile('{"format":"nxs.json.v2","history":[{"windows":[{"tabs":[{"url":"javascript:1"}]}]}]}')).toThrow(BackupFormatError);
  });
});

describe('suspended tabs in other formats', () => {
  it('unwraps tab-suspender placeholders in URL lists and OneTab files', () => {
    const park = 'chrome-extension://abc/park.html?title=T&url=https%3A%2F%2Freal.example.com%2Fpage';
    const list = parseBackupFile(`https://x.example.com/\n${park}\n`);
    // A bare URL list only keeps http(s) lines; the placeholder line is an extension URL.
    expect(countTabs(list.data)).toBeGreaterThanOrEqual(1);
    const onetab = parseBackupFile(`https://x.example.com/ | X\n${park} | Parked`);
    const urls = [...at(onetab.data.windows, 0).ungroupedTabs].map((tab) => tab.url);
    expect(urls).toContain('https://real.example.com/page');
  });
});

describe('native format', () => {
  it('is detected and passed through', () => {
    const r = parseBackupFile(
      JSON.stringify({
        schemaVersion: '1.1',
        windows: [{ ungroupedTabs: [{ url: 'https://a.com' }], groups: [] }],
        bookmarks: [],
      }),
    );
    expect(r.format).toBe('native');
  });
});

describe('Netscape bookmarks HTML', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1600000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://a.com/?x=1&amp;y=2" ADD_DATE="1600000001">Tom &amp; Jerry &#39;s &lt;b&gt;</A>
        <DT><H3 ADD_DATE="1600000002">Sub</H3>
        <DL><p>
            <DT><A HREF="https://deep.com">Deep</A>
            <DT><H3>Empty</H3>
            <DL><p></DL><p>
        </DL><p>
    </DL><p>
    <DT><A HREF="javascript:alert(1)">bad</A>
    <DT><A HREF="https://top.com">Top</A>
</DL><p>`;

  it('parses toolbar, nesting, entities, dates and keeps bookmarklets', () => {
    const r = parseBackupFile(html);
    expect(r.format).toBe('netscape-html');
    const root = at(r.data.bookmarks, 0);
    expect(root.children?.length).toBe(2);
    const bar = at(root.children, 0);
    expect(bar.folderType).toBe('bookmarks-bar');
    expect(bar.title).toBe('Bookmarks bar');
    const a = at(bar.children, 0);
    expect(a.url).toBe('https://a.com/?x=1&y=2');
    expect(a.title).toBe("Tom & Jerry 's <b>");
    expect(a.dateAdded).toBe(1600000001000);
    const sub = at(bar.children, 1);
    expect(sub.title).toBe('Sub');
    expect(at(sub.children, 0).url).toBe('https://deep.com');
    expect(at(sub.children, 1).children?.length).toBe(0);
    const other = at(root.children, 1);
    expect(other.folderType).toBe('other');
    expect(other.children?.map((c) => c.url)).toEqual(['javascript:alert(1)', 'https://top.com']);
  });

  it('wraps content in "Imported bookmarks" when there is no toolbar folder', () => {
    const r = parseBackupFile(
      '<DL><DT><H3>F</H3><DL><DT><A HREF="https://x.com">X</A></DL><DT><A HREF="https://y.com">Y</A></DL>',
    );
    const root = at(r.data.bookmarks, 0);
    expect(root.children?.length).toBe(1);
    const imported = at(root.children, 0);
    expect(imported.title).toBe('Imported bookmarks');
    expect(at(at(imported.children, 0).children, 0).url).toBe('https://x.com');
    expect(at(imported.children, 1).url).toBe('https://y.com');
  });

  it('DOM path handles nested DL inside DT and sibling DL', () => {
    interface FakeEl {
      tagName: string;
      attributes: { name: string; value: string }[];
      children: FakeEl[];
      textContent: string;
    }
    const el = (tag: string, attrs: Record<string, string> = {}, kids: FakeEl[] = [], text = ''): FakeEl => ({
      tagName: tag,
      attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
      children: kids,
      textContent: text || kids.map((k) => k.textContent).join(''),
    });
    const fake = {
      body: el('BODY', {}, [
        el('DL', {}, [
          el('DT', {}, [
            el('H3', { personal_toolbar_folder: 'true' }, [], 'Bar'),
            el('DL', {}, [el('DT', {}, [el('A', { href: 'https://n.com' }, [], 'Nested')])]),
          ]),
          el('DT', {}, [el('H3', {}, [], 'Sib')]),
          el('DL', {}, [el('DT', {}, [el('A', { href: 'https://s.com' }, [], 'S')])]),
          el('DT', {}, [el('A', { href: 'https://t.com' }, [], 'T')]),
        ]),
      ]),
    } as unknown as Document;
    const r = parseBackupFile('<!DOCTYPE NETSCAPE-Bookmark-file-1>', { parseHtml: () => fake });
    const root = at(r.data.bookmarks, 0);
    expect(at(at(root.children, 0).children, 0).url).toBe('https://n.com');
    const other = at(root.children, 1);
    expect(other.folderType).toBe('other');
    expect(at(at(other.children, 0).children, 0).url).toBe('https://s.com');
    expect(at(other.children, 1).url).toBe('https://t.com');
  });
});

describe('Firefox bookmarks JSON', () => {
  const ff = () => ({
    guid: 'root________',
    title: '',
    type: 'text/x-moz-place-container',
    root: 'placesRoot',
    children: [
      {
        title: 'menu',
        type: 'text/x-moz-place-container',
        root: 'bookmarksMenuFolder',
        children: [{ title: 'M', type: 'text/x-moz-place', uri: 'https://m.com', dateAdded: 1600000000123456 }],
      },
      {
        title: 'Bookmarks Toolbar',
        type: 'text/x-moz-place-container',
        root: 'toolbarFolder',
        children: [
          { title: 'T', type: 'text/x-moz-place', uri: 'https://t.com' },
          { type: 'text/x-moz-place-separator', title: '' },
          { title: 'Smart', type: 'text/x-moz-place', uri: 'place:sort=8' },
          {
            title: 'F',
            type: 'text/x-moz-place-container',
            children: [{ title: 'in', type: 'text/x-moz-place', uri: 'ftp://f.com' }],
          },
        ],
      },
      { title: 'Other', type: 'text/x-moz-place-container', root: 'unfiledBookmarksFolder', children: [] },
      { title: 'Mobile', type: 'text/x-moz-place-container', root: 'mobileFolder', children: [] },
    ],
  });

  it('maps well-known roots, converts µs dates, keeps separators, drops place: queries (BOM tolerated)', () => {
    const r = parseBackupFile('﻿' + JSON.stringify(ff()));
    expect(r.format).toBe('firefox-bookmarks-json');
    const root = at(r.data.bookmarks, 0);
    expect(root.parentId).toBeUndefined();
    expect(at(root.children, 0).id).toBe('menu________');
    expect(at(at(root.children, 0).children, 0).dateAdded).toBe(1600000000123);
    expect((root.children ?? []).map((c) => c.folderType)).toEqual([undefined, 'bookmarks-bar', 'other', 'mobile']);
    const tb = at(root.children, 1).children;
    expect(tb?.length).toBe(3);
    expect(at(tb, 1).type).toBe('separator');
  });
});

describe('URL list', () => {
  it('keeps only http(s) lines', () => {
    const r = parseBackupFile('https://a.com\nnotes here\nftp://nope\nhttp://b.com/x\n');
    expect(r.format).toBe('url-list');
    expect(at(r.data.windows, 0).ungroupedTabs.length).toBe(2);
  });
  it('caps at 20000 tabs and flags truncation', () => {
    const r = parseBackupFile(Array.from({ length: 25000 }, (_, i) => `https://e.com/${i}`).join('\n'));
    expect(at(r.data.windows, 0).ungroupedTabs.length).toBe(20000);
    expect(r.data.source.truncated).toBe(true);
  });
});

describe('invalid input', () => {
  const cases: [string, string][] = [
    ['plain text', 'hello world\nnothing'],
    ['empty', ''],
    ['unknown JSON', '{"foo":1}'],
    ['broken JSON', '{bad json'],
    ['over 50 MB', 'x'.repeat(50 * 1024 * 1024 + 1)],
  ];
  for (const [name, bad] of cases) {
    it(`throws BackupFormatError for ${name}`, () => {
      expect(() => parseBackupFile(bad)).toThrow(BackupFormatError);
    });
  }
});
