/**
 * Export tab: a live preview of what will be saved, switch rows for content,
 * collapsed Filters/Options, and the main action pinned at the bottom.
 */
import { useEffect, useMemo, useState } from 'react';
import { DownloadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldDescription, FieldGroup, FieldLabel, Field, FieldSeparator } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { send } from '@/lib/messaging';
import { t, tp } from '@/lib/i18n';
import type { ExportOptions, ExportStats } from '@/lib/types';
import { errorDetail, fmt, TONE, type Message, type SetStatus } from '../shared';
import { SettingsSection, SwitchRow } from './settings';

/** Wait for typing in the domain field to pause before recounting. */
const PREVIEW_DEBOUNCE_MS = 250;

const parseDomains = (value: string): string[] =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

function describeExport(stats: ExportStats | undefined, includeTabs: boolean, includeBookmarks: boolean): Message {
  const tabCount = stats?.tabs ?? 0;
  const bookmarkCount = stats?.bookmarks ?? 0;

  if (includeTabs && tabCount === 0) {
    return includeBookmarks && bookmarkCount > 0
      ? { text: tp('exportNoTabsButBookmarks', bookmarkCount, fmt(bookmarkCount)), tone: TONE.warning }
      : { text: t('exportNoTabsMatched'), tone: TONE.warning };
  }
  if (includeTabs) {
    const tabsAndWindows = [fmt(tabCount), fmt(stats?.windows)];
    return includeBookmarks
      ? { text: t('exportDoneWithBookmarks', [...tabsAndWindows, fmt(bookmarkCount)]), tone: TONE.success }
      : { text: t('exportDone', tabsAndWindows), tone: TONE.success };
  }
  return bookmarkCount > 0
    ? { text: tp('exportBookmarksDone', bookmarkCount, fmt(bookmarkCount)), tone: TONE.success }
    : { text: t('exportNoBookmarks'), tone: TONE.warning };
}

/** The button says exactly what will happen. */
function buttonLabel(tabs: boolean, bookmarks: boolean, stats: ExportStats | null): string {
  if (tabs && bookmarks) return t('exportButtonBoth');
  if (tabs && stats) return tp('exportButtonTabs', stats.tabs, fmt(stats.tabs));
  if (bookmarks && stats) return tp('exportButtonBookmarks', stats.bookmarks, fmt(stats.bookmarks));
  return t('exportButton');
}

/** Counts what EXPORT would save with these options; refreshed as options change. */
function useExportPreview(options: ExportOptions, enabled: boolean): ExportStats | null {
  const [stats, setStats] = useState<ExportStats | null>(null);
  const key = JSON.stringify(options);
  useEffect(() => {
    if (!enabled) {
      setStats(null);
      return;
    }
    let stale = false;
    setStats(null);
    const timer = setTimeout(async () => {
      const response = await send('EXPORT_PREVIEW', { options: JSON.parse(key) as ExportOptions });
      if (!stale && response.ok) setStats(response.stats);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [key, enabled]);
  return stats;
}

function PreviewStat({ value, label, loading }: { value: number | undefined; label: string; loading: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      {loading ? (
        <Skeleton className="h-6 w-10" />
      ) : (
        <span className="text-lg font-semibold tabular-nums">{value === undefined ? '–' : fmt(value)}</span>
      )}
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function ExportPanel({ setStatus }: { setStatus: SetStatus }) {
  const [tabs, setTabs] = useState(true);
  const [bookmarks, setBookmarks] = useState(true);
  const [bookmarklets, setBookmarklets] = useState(true);
  const [domain, setDomain] = useState('');
  const [filterBookmarks, setFilterBookmarks] = useState(false);
  const [excludeInternal, setExcludeInternal] = useState(true);
  const [favicons, setFavicons] = useState(false);
  const [unwrap, setUnwrap] = useState(true);
  const [layout, setLayout] = useState(true);
  const [busy, setBusy] = useState(false);

  const domains = parseDomains(domain);
  const anySelected = tabs || bookmarks;
  // Bookmark filtering only makes sense with a domain and bookmarks selected.
  const filterBookmarksDisabled = !(domains.length > 0 && bookmarks);

  const options: ExportOptions = useMemo(
    () => ({
      includeTabs: tabs,
      includeBookmarks: bookmarks,
      includeBookmarklets: bookmarklets,
      includeFavicons: favicons,
      unwrapPlaceholders: unwrap,
      includeWindowLayout: layout,
      filters: { excludeInternal, domains, applyToBookmarks: !filterBookmarksDisabled && filterBookmarks },
    }),
    // `domains` is derived from `domain`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, bookmarks, bookmarklets, favicons, unwrap, layout, excludeInternal, domain, filterBookmarksDisabled, filterBookmarks],
  );
  const stats = useExportPreview(options, anySelected);
  const loading = anySelected && stats === null;

  const filtersSummary = domains.length > 0 ? (domains.length > 1 ? `${domains[0]} +${domains.length - 1}` : domains[0]) : t('filtersOff');
  const optionsOn = [favicons, unwrap, layout].filter(Boolean).length;

  async function handleExport() {
    if (!anySelected) {
      setStatus(t('exportNothingSelected'), TONE.warning);
      return;
    }
    setBusy(true);
    const response = await send('EXPORT', { options, saveAs: true });
    setBusy(false);

    if (response.ok) {
      const outcome = describeExport(response.stats, tabs, bookmarks);
      setStatus(outcome.text, outcome.tone);
    } else if (response.cancelled) {
      setStatus(t('exportCancelled'));
    } else {
      setStatus(t('exportFailed', errorDetail(response)), TONE.error);
    }
  }

  return (
    <div id="export-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pt-2 pb-4">
        <section aria-label={t('exportPreviewLabel')} aria-busy={loading} className="grid grid-cols-4 gap-2 rounded-lg border bg-card px-3 py-3">
          <PreviewStat value={tabs ? stats?.tabs : 0} label={t('labelTabs')} loading={loading && tabs} />
          <PreviewStat value={tabs ? stats?.windows : 0} label={t('labelWindows')} loading={loading && tabs} />
          <PreviewStat value={tabs ? stats?.groups : 0} label={t('labelGroups')} loading={loading && tabs} />
          <PreviewStat value={bookmarks ? stats?.bookmarks : 0} label={t('labelBookmarks')} loading={loading && bookmarks} />
        </section>

        <FieldGroup className="gap-4">
          <SwitchRow id="ex-tabs" label={t('exportTabsPrimary')} description={t('exportTabsSecondary')} checked={tabs} onChange={setTabs} />
          <FieldSeparator />
          <SwitchRow
            id="ex-bookmarks"
            label={t('exportBookmarksPrimary')}
            description={t('exportBookmarksSecondary')}
            checked={bookmarks}
            onChange={setBookmarks}
          />
          <SwitchRow
            id="ex-bookmarklets"
            inset
            label={t('exportBookmarkletsPrimary')}
            description={t('exportBookmarkletsSecondary')}
            checked={bookmarklets}
            disabled={!bookmarks}
            onChange={setBookmarklets}
          />
        </FieldGroup>

        <SettingsSection id="export-filters" title={t('exportFiltersLabel')} summary={filtersSummary}>
          <Field>
            <FieldLabel htmlFor="ex-filter-domain">{t('exportDomainLabel')}</FieldLabel>
            <Input
              id="ex-filter-domain"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder={t('exportDomainPlaceholder')}
              autoComplete="off"
              spellCheck={false}
            />
            <FieldDescription>{t('exportDomainHint')}</FieldDescription>
          </Field>
          <SwitchRow
            id="ex-filter-bookmarks"
            label={t('exportApplyToBookmarks')}
            checked={filterBookmarks}
            disabled={filterBookmarksDisabled}
            onChange={setFilterBookmarks}
          />
          <SwitchRow id="ex-filter-exclude-internal" label={t('exportSkipInternal')} checked={excludeInternal} onChange={setExcludeInternal} />
        </SettingsSection>

        <SettingsSection id="export-options" title={t('exportOptionsSummary')} summary={tp('optionsOn', optionsOn, fmt(optionsOn))}>
          <SwitchRow id="ex-favicons" label={t('exportIncludeFavicons')} checked={favicons} onChange={setFavicons} />
          <SwitchRow id="ex-unwrap" label={t('exportUnwrapPlaceholders')} checked={unwrap} onChange={setUnwrap} />
          <SwitchRow id="ex-layout" label={t('exportIncludeWindowLayout')} checked={layout} onChange={setLayout} />
        </SettingsSection>
      </div>

      <div className="flex flex-col gap-2 border-t bg-background px-4 py-3">
        {!anySelected && (
          <p id="export-empty-hint" role="status" className="text-sm text-warning">
            {t('exportNothingSelected')}
          </p>
        )}
        <Button id="btn-export" size="lg" className="w-full" disabled={!anySelected || busy} onClick={() => void handleExport()}>
          {busy ? <Spinner data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
          {busy ? t('statusExporting') : buttonLabel(tabs, bookmarks, stats)}
        </Button>
      </div>
    </div>
  );
}
