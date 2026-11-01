/**
 * Netscape bookmark HTML converter (Chrome, Firefox, Edge, Safari, etc. "Export bookmarks").
 *
 * Both the DOM path (ctx.parseHtml) and the regex path produce the same intermediate tree
 * (HtmlItem), which is then converted by buildBackup().
 */

import { emptyBackup, BackupFormatError, type Backup, type BookmarkNode } from '../schema';
import { assertSize, decodeEntities } from './common';

const MAX_DEPTH = 100;

export interface HtmlFolder {
  folder: true;
  title: string;
  attrs: Record<string, string>;
  children: HtmlItem[];
}
export interface HtmlLink {
  folder: false;
  title: string;
  url: string;
  attrs: Record<string, string>;
}
export type HtmlItem = HtmlFolder | HtmlLink;

/** Whether the text looks like a Netscape bookmark file. */
export function looksLikeNetscapeHtml(text: string): boolean {
  return /<!DOCTYPE\s+NETSCAPE-Bookmark-file-1>/i.test(text) || /<DT>\s*<A\s+HREF/i.test(text);
}

/** Parses an attribute string into a lowercase-keyed object. */
export function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    attrs[(m[1] ?? '').toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, '')).trim();

/** Regex tokenizer path (no DOM needed). */
export function parseWithRegex(html: string): HtmlItem[] {
  const root: HtmlItem[] = [];
  const stack: HtmlItem[][] = [root];
  let pending: HtmlFolder | null = null;
  const top = (): HtmlItem[] => stack[stack.length - 1] ?? root;
  const re = /<H3\b([^>]*)>([\s\S]*?)<\/H3\s*>|<A\b([^>]*)>([\s\S]*?)<\/A\s*>|<DL\b[^>]*>|<\/DL\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0].charAt(1) === '/') {
      if (stack.length > 1) stack.pop();
      pending = null;
    } else if (m[2] !== undefined) {
      const folder: HtmlFolder = { folder: true, title: stripTags(m[2]), attrs: parseAttrs(m[1] ?? ''), children: [] };
      top().push(folder);
      pending = folder;
    } else if (m[4] !== undefined) {
      pending = null;
      const attrs = parseAttrs(m[3] ?? '');
      top().push({ folder: false, title: stripTags(m[4]), url: attrs.href ?? '', attrs });
    } else {
      // <DL>: opens the pending folder, or stays in the current container.
      if (stack.length < MAX_DEPTH) stack.push(pending ? pending.children : top());
      pending = null;
    }
  }
  return root;
}

function attrsOf(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name.toLowerCase()] = a.value;
  return attrs;
}

/** DOM path. Handles a DL nested inside its DT as well as a DL following the DT/H3. */
export function parseWithDom(doc: Document): HtmlItem[] {
  const root: HtmlItem[] = [];
  let pending: HtmlFolder | null = null;

  const walk = (el: Element, out: HtmlItem[], depth: number): void => {
    if (depth > MAX_DEPTH * 3) return;
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toUpperCase();
      if (tag === 'H3') {
        const folder: HtmlFolder = {
          folder: true,
          title: (child.textContent ?? '').trim(),
          attrs: attrsOf(child),
          children: [],
        };
        out.push(folder);
        pending = folder;
      } else if (tag === 'A') {
        pending = null;
        const attrs = attrsOf(child);
        out.push({ folder: false, title: (child.textContent ?? '').trim(), url: attrs.href ?? '', attrs });
      } else if (tag === 'DL') {
        const open: HtmlFolder | null = pending;
        const target = open ? open.children : out;
        pending = null;
        walk(child, target, depth + 1);
        pending = null;
      } else if (tag === 'DT' || tag === 'P' || tag === 'BODY' || tag === 'DD') {
        walk(child, out, depth + 1);
      }
    }
  };

  const start = doc.body ?? doc.documentElement;
  if (start) walk(start, root, 0);
  return root;
}

function addDate(attrs: Record<string, string>): number | undefined {
  const added = Number(attrs.add_date);
  return Number.isFinite(added) && added > 0 ? added * 1000 : undefined;
}

/** Converts intermediate items to bookmark nodes, counting URLs. */
function toNodes(items: HtmlItem[], stats: { urls: number }, depth = 0): BookmarkNode[] {
  const nodes: BookmarkNode[] = [];
  for (const item of items) {
    if (item.folder) {
      const node: BookmarkNode = {
        title: item.title,
        children: depth < MAX_DEPTH ? toNodes(item.children, stats, depth + 1) : [],
      };
      const added = addDate(item.attrs);
      if (added !== undefined) node.dateAdded = added;
      nodes.push(node);
    } else {
      const url = (item.url ?? '').trim();
      if (!url) continue; // bookmarklets (javascript:) are kept; the import option decides
      stats.urls++;
      const node: BookmarkNode = { title: item.title, url };
      const added = addDate(item.attrs);
      if (added !== undefined) node.dateAdded = added;
      nodes.push(node);
    }
  }
  return nodes;
}

/** Builds the native root structure from top-level items. */
function buildBackup(items: HtmlItem[], stats: { urls: number }): Backup {
  const isToolbar = (it: HtmlItem): it is HtmlFolder =>
    it.folder && String(it.attrs.personal_toolbar_folder).toLowerCase() === 'true';
  const toolbar = items.filter(isToolbar);
  const rest = items.filter((it) => !isToolbar(it));

  let children: BookmarkNode[];
  if (toolbar.length > 0) {
    children = toolbar.map((t) => ({
      title: t.title,
      folderType: 'bookmarks-bar',
      children: toNodes(t.children, stats, 1),
    }));
    const other = toNodes(rest, stats, 1);
    if (other.length > 0) children.push({ title: 'Other bookmarks', folderType: 'other', children: other });
  } else {
    children = [{ title: 'Imported bookmarks', children: toNodes(rest, stats, 1) }];
  }
  const backup = emptyBackup({ format: 'netscape-html', browser: 'unknown' });
  backup.bookmarks = [{ title: '', children }];
  return backup;
}

/**
 * Converts Netscape bookmark HTML to a (not yet normalised) native backup object.
 * @throws {BackupFormatError}
 */
export function convertNetscapeHtml(
  text: string,
  ctx: { parseHtml?: (html: string) => Document } = {},
): Backup {
  assertSize(text);
  const items = typeof ctx.parseHtml === 'function' ? parseWithDom(ctx.parseHtml(text)) : parseWithRegex(text);
  const stats = { urls: 0 };
  const backup = buildBackup(items, stats);
  if (stats.urls === 0) throw new BackupFormatError('No bookmarks found in the HTML file.');
  return backup;
}
