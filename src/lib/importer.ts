/**
 * Universal Importer: validates a backup and orchestrates the bookmark and tab phases.
 */
import { BookmarksAdapter, type BookmarksImportOptions, type BookmarksImportResult } from './adapters/bookmarks-adapter';
import { TabAdapter, type TabImportOptions, type TabImportStats } from './adapters/tab-adapter';
import type { BrowserInfo } from './browser-detect';
import { logger } from './logger';
import { countTabs, normalizeBackup, type BookmarkNode, type BackupWindow, type Backup } from './schema';
import type { Failure, ImportOptions, ImportProgress, ImportResult } from './types';

/** Maximum number of failure entries kept in the result (counting continues beyond it). */
const MAX_FAILURES = 500;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** User-visible messages (kept together so they can be localized later). */
const MESSAGES = {
  noBookmarksApi: 'This browser has no bookmarks API.',
  bookmarksFailed: (e: unknown) => `Bookmarks import failed: ${errText(e)}`,
  tabsFailed: (e: unknown) => `Tabs import failed: ${errText(e)}`,
  backupFailed: (e: unknown) =>
    `Could not back up existing bookmarks, so nothing was replaced: ${errText(e)}`,
  importingBookmarks: 'Importing bookmarks…',
  done: 'Done',
};

export interface ImporterDeps {
  browser: BrowserInfo;
  bookmarksAdapter?: Pick<BookmarksAdapter, 'import'>;
}

export type ImporterOptions = ImportOptions & {
  onProgress?: (p: ImportProgress) => void;
  isCancelled?: () => boolean;
  /** Runs before the destructive 'replace' strategy; a rejection aborts the bookmark phase. */
  beforeReplace?: () => Promise<void>;
};

type AddFailure = (kind: Failure['kind'], f: Omit<Failure, 'kind'>) => void;

export class UniversalImporter {
  readonly browser: BrowserInfo;
  /** Replaceable for tests. */
  tabAdapter: Pick<TabAdapter, 'importWindows'>;
  bookmarksAdapter: Pick<BookmarksAdapter, 'import'>;

  constructor({ browser, bookmarksAdapter }: ImporterDeps) {
    this.browser = browser;
    this.tabAdapter = new TabAdapter(browser);
    this.bookmarksAdapter = bookmarksAdapter ?? new BookmarksAdapter({ family: browser?.family });
  }

  /**
   * @param rawData parsed backup JSON
   * @returns counters, failures, errors, warnings and cancelled flag
   * @throws {BackupFormatError} when rawData is not a backup
   */
  async import(rawData: unknown, options: ImporterOptions = { importTabs: false, importBookmarks: false }): Promise<ImportResult> {
    const { data, warnings } = normalizeBackup(rawData);
    const result: ImportResult = {
      tabs: 0,
      groups: 0,
      windows: 0,
      tabsSkipped: 0,
      tabsFailed: 0,
      bookmarks: 0,
      bookmarksSkipped: 0,
      bookmarksFailed: 0,
      failures: [],
      errors: [],
      warnings,
      cancelled: false,
    };
    const failureCount = { total: 0 };
    const addFailure: AddFailure = (kind, f) => {
      failureCount.total++;
      if (result.failures.length < MAX_FAILURES) result.failures.push({ ...f, kind });
    };

    logger.info('IMPORT_START', { schemaVersion: data.schemaVersion });

    if (options.importBookmarks && data.bookmarks.length > 0) {
      await this.importBookmarks(data, options, result, addFailure);
    }
    if (options.isCancelled?.()) result.cancelled = true;

    if (options.importTabs && data.windows.length > 0 && !result.cancelled) {
      await this.importTabs(data, options, result, addFailure);
    }

    options.onProgress?.({ phase: 'done', current: 1, total: 1, message: MESSAGES.done });
    logger.info('IMPORT_COMPLETE', { ...result, failures: result.failures.length, failureCount: failureCount.total });
    return result;
  }

  private async importBookmarks(
    data: Backup,
    options: ImporterOptions,
    result: ImportResult,
    addFailure: AddFailure,
  ): Promise<void> {
    if (!this.browser?.features?.bookmarks) {
      result.errors.push(MESSAGES.noBookmarksApi);
      return;
    }
    const strategy = options.bookmarkStrategy ?? 'merge';
    try {
      if (strategy === 'replace' && options.beforeReplace) {
        try {
          await options.beforeReplace();
        } catch (e) {
          logger.error('IMPORT_BEFORE_REPLACE_FAIL', {}, e);
          result.errors.push(MESSAGES.backupFailed(e));
          return;
        }
      }
      const report = (current: number, total: number) =>
        options.onProgress?.({ phase: 'bookmarks', current, total, message: MESSAGES.importingBookmarks });
      report(0, 0);
      const adapterOptions: BookmarksImportOptions = {
        strategy,
        skipDuplicates: options.skipDuplicateBookmarks !== false,
        includeBookmarklets: options.importBookmarklets !== false,
        isCancelled: options.isCancelled,
        onProgress: report,
        onFailure: (f) => addFailure('bookmark', f),
      };
      const nodes: BookmarkNode[] = data.bookmarks;
      const res: Partial<BookmarksImportResult> | undefined = await this.bookmarksAdapter.import(nodes, adapterOptions);
      result.bookmarks = res?.created ?? 0;
      result.bookmarksSkipped = res?.skipped ?? 0;
      result.bookmarksFailed = res?.failed ?? 0;
      if (res?.cancelled) result.cancelled = true;
    } catch (e) {
      logger.error('IMPORT_BOOKMARKS_FAIL', {}, e);
      result.errors.push(MESSAGES.bookmarksFailed(e));
    }
  }

  private async importTabs(
    data: Backup,
    options: ImporterOptions,
    result: ImportResult,
    addFailure: AddFailure,
  ): Promise<void> {
    const total = countTabs(data);
    try {
      const windows: BackupWindow[] = data.windows;
      const adapterOptions: TabImportOptions = {
        restoreMode: options.restoreMode,
        restoreWindowLayout: options.restoreWindowLayout,
        skipOpenTabs: options.skipOpenTabs,
        skipBlankTabs: options.skipBlankTabs,
        focusRestored: options.focusRestored,
        isCancelled: options.isCancelled,
        onProgress: (done, message) => options.onProgress?.({ phase: 'tabs', current: done, total, message }),
        onFailure: (f) => addFailure(f.kind, f),
      };
      const res: TabImportStats = await this.tabAdapter.importWindows(windows, adapterOptions);
      result.tabs = res.tabs;
      result.groups = res.groups;
      result.windows = res.windows;
      result.tabsSkipped = res.skipped;
      result.tabsFailed = res.failed;
      if (res.cancelled) result.cancelled = true;
    } catch (e) {
      logger.error('IMPORT_TABS_FAIL', {}, e);
      result.errors.push(MESSAGES.tabsFailed(e));
    }
  }
}
