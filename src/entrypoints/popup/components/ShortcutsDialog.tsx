/**
 * Lists the extension's keyboard shortcuts as the browser actually has them (a
 * suggested key may be unassigned because of a conflict, or changed by the user),
 * and opens the browser's shortcut settings.
 */
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { KeyboardIcon } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { t } from '@/lib/i18n';
import type { BrowserInfo } from '@/lib/browser-detect';

/** Chromium browsers redirect chrome:// to their own scheme (edge://, brave://, ...). */
const CHROMIUM_SHORTCUTS_URL = 'chrome://extensions/shortcuts';

interface Shortcut {
  name: string;
  description: string;
  shortcut: string;
}

type CommandsApi = {
  getAll?: () => Promise<Array<{ name?: string; description?: string; shortcut?: string }>>;
  /** Firefox 137+. */
  openShortcutSettings?: () => Promise<void>;
};

const commandsApi = (): CommandsApi | undefined => (browser as unknown as { commands?: CommandsApi }).commands;

/** "Ctrl+Shift+Period" -> ["Ctrl", "Shift", "."] for display. */
function keysOf(shortcut: string): string[] {
  const NAMES: Record<string, string> = { Period: '.', Comma: ',', Command: '⌘', MacCtrl: 'Ctrl' };
  return shortcut.split('+').map((part) => NAMES[part] ?? part);
}

export function ShortcutsDialog({
  open,
  onOpenChange,
  browserInfo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  browserInfo: BrowserInfo;
}) {
  const [shortcuts, setShortcuts] = useState<Shortcut[] | null>(null);
  const [error, setError] = useState(false);
  const [firefoxHelp, setFirefoxHelp] = useState(false);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setError(false);
    setFirefoxHelp(false);
    void (async () => {
      try {
        const all = (await commandsApi()?.getAll?.()) ?? [];
        if (stale) return;
        setShortcuts(
          all.map((c) => ({
            name: c.name ?? '',
            // _execute_action has no description of its own.
            description: c.name === '_execute_action' || !c.description ? t('shortcutOpenPopup') : c.description,
            shortcut: c.shortcut ?? '',
          })),
        );
      } catch {
        if (!stale) setError(true);
      }
    })();
    return () => {
      stale = true;
    };
  }, [open]);

  async function openSettings() {
    try {
      if (browserInfo.key === 'firefox') {
        const api = commandsApi();
        if (api?.openShortcutSettings) {
          await api.openShortcutSettings();
          return;
        }
        // Older Firefox: extensions can't open about:addons, so explain where it is.
        setFirefoxHelp(true);
        return;
      }
      await browser.tabs.create({ url: CHROMIUM_SHORTCUTS_URL });
      window.close();
    } catch {
      setFirefoxHelp(browserInfo.key === 'firefox');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent id="shortcuts-dialog" closeLabel={t('dialogClose')}>
        <DialogHeader>
          <DialogTitle>{t('shortcutsTitle')}</DialogTitle>
          <DialogDescription>{t('shortcutsIntro')}</DialogDescription>
        </DialogHeader>

        {error ? (
          <p className="text-sm text-destructive">{t('shortcutsLoadFailed')}</p>
        ) : (
          <ul id="shortcuts-list" className="flex flex-col divide-y rounded-lg border">
            {(shortcuts ?? []).map((s) => (
              <li key={s.name} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="text-sm">{s.description}</span>
                {s.shortcut ? (
                  <span className="flex shrink-0 items-center gap-1" aria-label={s.shortcut}>
                    {keysOf(s.shortcut).map((key, i) => (
                      <kbd key={i} className="rounded border bg-muted px-1.5 py-0.5 font-sans text-xs font-medium">
                        {key}
                      </kbd>
                    ))}
                  </span>
                ) : (
                  <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
                    {t('shortcutNotSet')}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}

        <Alert>
          <KeyboardIcon />
          <AlertDescription>{t('shortcutsHint')}</AlertDescription>
        </Alert>
        {firefoxHelp && (
          <p id="shortcuts-firefox-help" role="status" className="text-sm text-muted-foreground">
            {t('shortcutsFirefoxHow')}
          </p>
        )}

        <DialogFooter>
          <Button id="btn-change-shortcuts" onClick={() => void openSettings()}>
            {t('shortcutsChange')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
