import { useState } from 'react';
import { send } from '@/lib/messaging';
import { t, tp } from '@/lib/i18n';
import type { ExportOptions, ExportStats } from '@/lib/types';
import { errorDetail, fmt, TONE, type Message, type SetStatus } from '../shared';
import { CheckboxSimple, CheckboxWrap, Hint, Panel, PanelIntro } from './ui';

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

export function ExportPanel({ active, setStatus }: { active: boolean; setStatus: SetStatus }) {
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
  const [result, setResult] = useState<Message | null>(null);

  const domains = parseDomains(domain);
  const anySelected = tabs || bookmarks;
  // Bookmark filtering only makes sense with a domain and bookmarks selected.
  const filterBookmarksDisabled = !(domains.length > 0 && bookmarks);

  async function handleExport() {
    if (!anySelected) {
      setStatus(t('exportNothingSelected'), TONE.warning);
      return;
    }
    setBusy(true);
    setResult(null);
    setStatus(t('statusExporting'));

    const options: ExportOptions = {
      includeTabs: tabs,
      includeBookmarks: bookmarks,
      includeBookmarklets: bookmarklets,
      includeFavicons: favicons,
      unwrapPlaceholders: unwrap,
      includeWindowLayout: layout,
      filters: {
        excludeInternal,
        domains,
        applyToBookmarks: !filterBookmarksDisabled && filterBookmarks,
      },
    };
    const response = await send('EXPORT', { options, saveAs: true });
    setBusy(false);

    let outcome: Message;
    if (response.ok) outcome = describeExport(response.stats, tabs, bookmarks);
    else if (response.cancelled) outcome = { text: t('exportCancelled') };
    else outcome = { text: t('exportFailed', errorDetail(response)), tone: TONE.error };

    setResult(outcome);
    setStatus(outcome.text, outcome.tone);
  }

  return (
    <Panel name="export" active={active}>
      <PanelIntro title={t('exportTitle')} text={t('exportIntro')} />

      <div className="card">
        <h3 className="section-label" id="export-content-label">
          {t('exportContentLabel')}
        </h3>
        <div className="checkbox-group" role="group" aria-labelledby="export-content-label">
          <CheckboxWrap id="ex-tabs" checked={tabs} onChange={setTabs} primary={t('exportTabsPrimary')} secondary={t('exportTabsSecondary')} />
          <CheckboxWrap
            id="ex-bookmarks"
            checked={bookmarks}
            onChange={setBookmarks}
            primary={t('exportBookmarksPrimary')}
            secondary={t('exportBookmarksSecondary')}
          />
        </div>
        <div className="check-list sub-option">
          <CheckboxSimple id="ex-bookmarklets" checked={bookmarklets} disabled={!bookmarks} onChange={setBookmarklets}>
            {t('exportIncludeBookmarklets')}
          </CheckboxSimple>
        </div>
        <Hint id="export-empty-hint" tone={TONE.warning} text={anySelected ? null : t('exportNothingSelected')} />
      </div>

      <div className="card">
        <h3 className="section-label">{t('exportFiltersLabel')}</h3>
        <div className="form-row">
          <label htmlFor="ex-filter-domain">{t('exportDomainLabel')}</label>
          <input
            type="text"
            id="ex-filter-domain"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder={t('exportDomainPlaceholder')}
            aria-describedby="ex-filter-domain-hint"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="field-hint" id="ex-filter-domain-hint">
            {t('exportDomainHint')}
          </p>
        </div>
        <div className="check-list">
          <CheckboxSimple id="ex-filter-bookmarks" checked={filterBookmarks} disabled={filterBookmarksDisabled} onChange={setFilterBookmarks}>
            {t('exportApplyToBookmarks')}
          </CheckboxSimple>
          <CheckboxSimple id="ex-filter-exclude-internal" checked={excludeInternal} onChange={setExcludeInternal}>
            {t('exportSkipInternal')}
          </CheckboxSimple>
        </div>
      </div>

      <details className="card options-card">
        <summary>{t('exportOptionsSummary')}</summary>
        <div className="check-list">
          <CheckboxSimple id="ex-favicons" checked={favicons} onChange={setFavicons}>
            {t('exportIncludeFavicons')}
          </CheckboxSimple>
          <CheckboxSimple id="ex-unwrap" checked={unwrap} onChange={setUnwrap}>
            {t('exportUnwrapPlaceholders')}
          </CheckboxSimple>
          <CheckboxSimple id="ex-layout" checked={layout} onChange={setLayout}>
            {t('exportIncludeWindowLayout')}
          </CheckboxSimple>
        </div>
      </details>

      <Hint id="export-result" text={result?.text} tone={result?.tone} />

      <div className="actions-footer">
        <button type="button" id="btn-export" className="btn-primary" disabled={!anySelected || busy} onClick={handleExport}>
          {t('exportButton')}
        </button>
      </div>
    </Panel>
  );
}
