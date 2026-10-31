import { Fragment } from 'react';
import { t, tp } from '@/lib/i18n';
import type { Failure, ImportState } from '@/lib/types';
import { copyText, fmt, messageOf, TONE, type SetStatus, type Tone } from '../shared';
import { Hint } from './ui';

const FAILURE_REASON_KEYS: Record<string, string> = {
  'internal-page': 'failureInternalPage',
  'unsafe-scheme': 'failureUnsafeScheme',
  'file-url-blocked': 'failureFileUrlBlocked',
  'invalid-url': 'failureInvalidUrl',
  'empty-url': 'failureEmptyUrl',
  'unsupported-url': 'failureUnsupportedUrl',
  'window-create-failed': 'failureWindowCreateFailed',
};
const FAILURE_KIND_KEYS: Record<string, string> = {
  tab: 'failureKindTab',
  group: 'failureKindGroup',
  bookmark: 'failureKindBookmark',
};

const failureReason = (reason: unknown): string => {
  const key = FAILURE_REASON_KEYS[String(reason)];
  return key ? t(key) : String(reason ?? t('errorUnknown'));
};
const failureKind = (kind: unknown): string => {
  const key = FAILURE_KIND_KEYS[String(kind)];
  return key ? t(key) : String(kind ?? '');
};

/** Footer/summary sentence for a finished restore, or null while it is not finished. */
export function describeFinish(state: ImportState): { message: string; tone: Tone } | null {
  const result = state.result;
  const counts = [fmt(result?.tabs), fmt(result?.bookmarks)];
  if (state.status === 'error') return { message: t('statusImportFailed', state.error || t('errorUnknown')), tone: TONE.error };
  if (state.status === 'cancelled') return { message: t('statusImportCancelled', counts), tone: TONE.warning };
  if (state.status === 'done') {
    const problems = (result?.tabsFailed ?? 0) + (result?.bookmarksFailed ?? 0) + (result?.errors?.length ?? 0);
    return problems > 0
      ? { message: t('statusImportDoneIssues', counts), tone: TONE.warning }
      : { message: t('statusImportDone', counts), tone: TONE.success };
  }
  return null;
}

export function ResultsCard({
  state,
  visible,
  onDismiss,
  setStatus,
}: {
  state: ImportState;
  visible: boolean;
  onDismiss: () => void;
  setStatus: SetStatus;
}) {
  if (!visible) return null;
  const outcome = describeFinish(state);
  const result = state.result;
  const errors = result?.errors ?? [];
  const failures: Failure[] = result?.failures ?? [];

  const rows: Array<[string, number, boolean?]> = result
    ? [
        ['resultTabs', result.tabs],
        ['resultWindows', result.windows],
        ['resultGroups', result.groups],
        ['resultBookmarks', result.bookmarks],
        ['resultTabsSkipped', result.tabsSkipped],
        ['resultBookmarksSkipped', result.bookmarksSkipped],
        ['resultTabsFailed', result.tabsFailed, true],
        ['resultBookmarksFailed', result.bookmarksFailed, true],
      ]
    : [];

  async function copyFailures() {
    const lines = failures.map((f) => [failureKind(f.kind), f.title ?? '', f.url ?? '', failureReason(f.reason)].join('\t'));
    try {
      await copyText(lines.join('\n'));
      setStatus(t('failuresCopied'), TONE.success);
    } catch (error) {
      setStatus(t('copyFailed', messageOf(error)), TONE.error);
    }
  }

  return (
    <section className="card" id="results-card" aria-labelledby="results-title">
      <div className="card-head">
        <h3 className="section-label" id="results-title">
          {t('resultsTitle')}
        </h3>
        <button type="button" id="btn-results-dismiss" className="btn-link" onClick={onDismiss}>
          {t('resultsDismiss')}
        </button>
      </div>
      <Hint id="results-summary" className="no-top" text={outcome?.message} tone={outcome?.tone} />
      {result && (
        <dl id="results-stats" className="stat-grid">
          {rows.map(([labelKey, value, isFailure]) => (
            <Fragment key={labelKey}>
              <dt>{t(labelKey)}</dt>
              <dd className={isFailure && value > 0 ? 'is-bad' : undefined}>{fmt(value)}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {errors.length > 0 && (
        <div id="results-errors-wrap">
          <h4 className="sub-label">{t('resultsErrorsLabel')}</h4>
          <ul id="results-errors" className="plain-list">
            {errors.map((message, i) => (
              <li key={i}>{String(message)}</li>
            ))}
          </ul>
        </div>
      )}
      {failures.length > 0 && (
        <details id="results-failures" className="failures">
          <summary id="results-failures-summary">{tp('failuresSummary', failures.length, fmt(failures.length))}</summary>
          <div className="failures-actions">
            <button type="button" id="btn-copy-failures" className="btn-small" onClick={copyFailures}>
              {t('failuresCopy')}
            </button>
          </div>
          <ul id="results-failures-list" className="failure-list">
            {failures.map((failure, i) => (
              <li key={i}>
                <span className="failure-title">{failure.title || failure.url || failureKind(failure.kind)}</span>
                {failure.title && failure.url && <span className="failure-url">{failure.url}</span>}
                <span className="failure-reason">{failureReason(failure.reason)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
