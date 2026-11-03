/** Body shown while a restore runs: progress, the current phase, and a pinned Cancel button. */
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { send } from '@/lib/messaging';
import { t } from '@/lib/i18n';
import type { ImportState } from '@/lib/types';
import { errorDetail, fmt, TONE, type SetStatus } from '../shared';

const PERCENT_MAX = 100;
const PHASE_KEYS: Record<string, string> = {
  starting: 'phaseStarting',
  bookmarks: 'phaseBookmarks',
  tabs: 'phaseTabs',
  done: 'phaseDone',
};

function phaseMessage(state: ImportState): string {
  if (state.status === 'cancelling') return t('statusCancelling');
  const key = state.phase ? PHASE_KEYS[state.phase] : undefined;
  return key ? t(key) : state.message || t('statusRestoring');
}

/** Moves keyboard focus into a view that just replaced the control that had it. */
export const useFocusOnMount = () => useCallback((el: HTMLElement | null) => el?.focus({ preventScroll: true }), []);

export function ImportProgress({ state, setStatus }: { state: ImportState; setStatus: SetStatus }) {
  const [cancelBusy, setCancelBusy] = useState(false);
  const focusOnMount = useFocusOnMount();
  const { current = 0, total = 0 } = state;
  const percent = total > 0 ? Math.min((current / total) * PERCENT_MAX, PERCENT_MAX) : 0;
  const cancelling = state.status === 'cancelling';

  async function handleCancel() {
    setCancelBusy(true);
    const response = await send('IMPORT_CANCEL');
    setCancelBusy(false);
    // On success the broadcast ("cancelling") keeps the button disabled.
    if (!response.ok) setStatus(errorDetail(response), TONE.error);
  }

  return (
    <>
      <div id="import-progress" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 py-4 text-center">
        <Spinner className="size-6 text-muted-foreground" />
        <div className="flex w-full flex-col gap-1">
          <h2 ref={focusOnMount} tabIndex={-1} className="text-sm font-medium outline-none" role="status">
            {phaseMessage(state)}
          </h2>
          <p id="import-progress-text" className="text-sm tabular-nums text-muted-foreground">
            {total > 0 ? `${fmt(current)} / ${fmt(total)}` : ' '}
          </p>
        </div>
        <Progress value={percent} aria-label={t('progressLabel')} className="h-2" />
        <p className="text-xs text-muted-foreground">{t('importRunningNote')}</p>
      </div>

      <div className="flex flex-col gap-2 border-t bg-background px-4 py-3">
        <Button
          type="button"
          id="btn-cancel"
          variant="outline"
          size="lg"
          className="w-full"
          disabled={cancelling || cancelBusy}
          onClick={() => void handleCancel()}
        >
          {t('importCancel')}
        </Button>
      </div>
    </>
  );
}
