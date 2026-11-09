/**
 * Where automatic backup files go: the default folder (Downloads/TabVault) or a
 * folder the user picks.
 *
 * Chromium: "Choose folder…" opens the system folder picker (File System Access API).
 * Pickers close the action popup on some systems, so in the popup the button opens
 * the full-tab view, the same way the Import file picker does.
 * Firefox has no folder picker: extensions can only save inside Downloads, so the
 * user types the name of a folder there instead.
 */
import { useCallback, useEffect, useState } from 'react';
import { FolderIcon, FolderOpenIcon, RotateCcwIcon, ShieldAlertIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  clearBackupFolder,
  folderAccess,
  folderPickerSupported,
  getBackupFolder,
  requestFolderAccess,
  setBackupFolder,
  type FolderAccess,
} from '@/lib/backup-folder';
import { t } from '@/lib/i18n';
import type { FileLocation } from '@/lib/types';
import { cn } from '@/lib/utils';
import { messageOf, TONE, type SetStatus } from '../shared';

export const DEFAULT_DOWNLOADS_FOLDER = 'TabVault';

export interface LocationSettings {
  fileLocation: FileLocation;
  downloadsFolder: string;
}

interface Props {
  value: LocationSettings;
  disabled?: boolean;
  isTabView: boolean;
  /** Opens the full-tab view on this section (pickers close the popup). */
  openInTab: () => void;
  /** Saves a change; resolves false when the background rejected it. */
  onChange: (patch: Partial<LocationSettings>) => Promise<boolean>;
  setStatus: SetStatus;
}

type PickerWindow = typeof globalThis & {
  showDirectoryPicker: (options?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
};

export function BackupFileLocation({ value, disabled, isTabView, openInTab, onChange, setStatus }: Props) {
  const [canPick] = useState(folderPickerSupported);
  /** The picked folder as stored, with whether the extension may still write to it. */
  const [folder, setFolder] = useState<{ name: string; access: FolderAccess; handle: FileSystemDirectoryHandle } | null>(null);
  const [subfolder, setSubfolder] = useState(value.downloadsFolder);
  const [busy, setBusy] = useState(false);

  const loadFolder = useCallback(async () => {
    const stored = canPick ? await getBackupFolder() : null;
    setFolder(stored ? { name: stored.handle.name, access: await folderAccess(stored.handle), handle: stored.handle } : null);
  }, [canPick]);

  useEffect(() => {
    void loadFolder();
  }, [loadFolder, value.fileLocation]);

  useEffect(() => setSubfolder(value.downloadsFolder), [value.downloadsFolder]);

  const usingFolder = value.fileLocation === 'folder';
  const isDefault = !usingFolder && value.downloadsFolder === DEFAULT_DOWNLOADS_FOLDER;
  const needsAccess = usingFolder && folder !== null && folder.access !== 'granted';
  const missing = usingFolder && canPick && folder === null;
  const shown = usingFolder ? (folder?.name ?? t('fileLocationChosen')) : `${t('fileLocationDownloads')}/${value.downloadsFolder}`;

  async function chooseFolder() {
    if (!isTabView) {
      openInTab();
      return;
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await (globalThis as PickerWindow).showDirectoryPicker({ id: 'tabvault-backups', mode: 'readwrite', startIn: 'downloads' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return; // closed the picker
      setStatus(t('fileLocationFailed', messageOf(error)), TONE.error);
      return;
    }
    setBusy(true);
    try {
      await setBackupFolder(handle);
      if (await onChange({ fileLocation: 'folder' })) setStatus(t('fileLocationSet', handle.name), TONE.success);
    } catch (error) {
      setStatus(t('fileLocationFailed', messageOf(error)), TONE.error);
    } finally {
      setBusy(false);
      await loadFolder();
    }
  }

  async function allowAccess() {
    if (!folder) return;
    if (!isTabView) {
      openInTab();
      return;
    }
    try {
      const access = await requestFolderAccess(folder.handle);
      if (access === 'granted') setStatus(t('fileLocationSet', folder.name), TONE.success);
    } catch (error) {
      setStatus(t('fileLocationFailed', messageOf(error)), TONE.error);
    }
    await loadFolder();
  }

  async function useDefault() {
    setBusy(true);
    try {
      if (await onChange({ fileLocation: 'downloads', downloadsFolder: DEFAULT_DOWNLOADS_FOLDER })) {
        await clearBackupFolder().catch(() => {});
        setStatus(t('fileLocationReset'), TONE.success);
      }
    } finally {
      setBusy(false);
      await loadFolder();
    }
  }

  function commitSubfolder() {
    const next = subfolder.trim();
    if (next === value.downloadsFolder) return;
    if (!next) {
      setSubfolder(value.downloadsFolder);
      return;
    }
    void onChange({ downloadsFolder: next });
  }

  return (
    <div id="bk-location" className="flex flex-col gap-2 pl-6" data-disabled={disabled || undefined}>
      <Field>
        <FieldLabel id="bk-location-label">{t('fileLocationLabel')}</FieldLabel>
        <div
          className={cn('flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm', disabled && 'opacity-50')}
          aria-labelledby="bk-location-label"
          role="group"
        >
          {usingFolder ? <FolderOpenIcon aria-hidden="true" className="size-4 flex-none text-primary" /> : <FolderIcon aria-hidden="true" className="size-4 flex-none text-muted-foreground" />}
          <span id="bk-location-path" className="min-w-0 flex-1 truncate" title={shown}>
            {shown}
          </span>
          {isDefault && (
            <Badge variant="secondary" className="flex-none font-normal">
              {t('fileLocationDefaultBadge')}
            </Badge>
          )}
        </div>
      </Field>

      {(needsAccess || missing) && (
        <p id="bk-location-warning" role="status" className="flex items-start gap-1.5 text-xs text-warning">
          <ShieldAlertIcon aria-hidden="true" className="mt-px size-3.5 flex-none" />
          <span>{t(missing ? 'fileLocationMissing' : 'fileLocationNeedsAccess', `${t('fileLocationDownloads')}/${value.downloadsFolder}`)}</span>
        </p>
      )}

      {canPick ? (
        <>
          <div className="flex flex-wrap gap-2">
            {needsAccess && (
              <Button id="bk-allow-folder" size="sm" disabled={disabled || busy} onClick={() => void allowAccess()}>
                {t('fileLocationAllow')}
              </Button>
            )}
            <Button id="bk-choose-folder" variant="outline" size="sm" disabled={disabled || busy} onClick={() => void chooseFolder()}>
              <FolderOpenIcon data-icon="inline-start" />
              {t('fileLocationChoose')}
            </Button>
            {!isDefault && (
              <Button id="bk-default-folder" variant="ghost" size="sm" disabled={disabled || busy} onClick={() => void useDefault()}>
                <RotateCcwIcon data-icon="inline-start" />
                {t('fileLocationUseDefault')}
              </Button>
            )}
          </div>
          {!isTabView && <p className="text-xs text-muted-foreground">{t('fileLocationOpensTab')}</p>}
        </>
      ) : (
        <Field>
          <FieldContent>
            <FieldLabel htmlFor="bk-subfolder">{t('fileLocationSubfolderLabel')}</FieldLabel>
            <FieldDescription id="bk-subfolder-hint">{t('fileLocationSubfolderHint')}</FieldDescription>
          </FieldContent>
          <div className="flex gap-2">
            <Input
              id="bk-subfolder"
              className="min-w-0 flex-1"
              aria-describedby="bk-subfolder-hint"
              placeholder={DEFAULT_DOWNLOADS_FOLDER}
              value={subfolder}
              disabled={disabled || busy}
              onChange={(event) => setSubfolder(event.target.value)}
              onBlur={commitSubfolder}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitSubfolder();
              }}
            />
            {!isDefault && (
              <Button id="bk-default-folder" variant="ghost" size="sm" className="h-9" disabled={disabled || busy} onClick={() => void useDefault()}>
                <RotateCcwIcon data-icon="inline-start" />
                {t('fileLocationUseDefault')}
              </Button>
            )}
          </div>
        </Field>
      )}
    </div>
  );
}
