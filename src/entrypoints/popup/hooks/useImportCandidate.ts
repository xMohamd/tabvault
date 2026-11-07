import { useCallback, useRef, useState } from 'react';
import { t } from '@/lib/i18n';
import type { EncryptedEnvelope } from '@/lib/crypto';
import { countBookmarks, countTabs, type Backup, type NormalizeWarnings } from '@/lib/schema';
import { TONE, type Message } from '../shared';

/** A normalized backup shown in the Import tab (from a file or a snapshot). */
export interface Candidate {
  /** Changes on every load; components keyed by it drop per-backup state. */
  id: number;
  data: Backup;
  hasTabs: boolean;
  hasBookmarks: boolean;
  label: string;
  /** File name when the backup came from a file (snapshots and search results have none). */
  fileName?: string;
  warnings: NormalizeWarnings | undefined;
}

export interface AcceptArgs {
  data: Backup;
  label: string;
  fileName?: string;
  warnings: NormalizeWarnings | undefined;
  message: string;
}

/** A password-protected file waiting for its password. */
export interface LockedFile {
  envelope: EncryptedEnvelope;
  filename: string;
}

/**
 * Owns the import candidate and the messages around it. Lives in App because a
 * snapshot restored from the Backups tab becomes the candidate of the Import tab.
 */
export function useImportCandidate() {
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [fileInfo, setFileInfo] = useState<Message | null>(null);
  const [importMessage, setImportMessage] = useState<Message | null>(null);
  const [locked, setLocked] = useState<LockedFile | null>(null);
  const seq = useRef(0);

  /** Clears everything derived from a previously loaded backup. */
  const reset = useCallback(() => {
    setCandidate(null);
    setLocked(null);
    setFileInfo(null);
    setImportMessage(null);
  }, []);

  /** Makes a normalized backup the import candidate, exactly as if it had been chosen as a file. */
  const accept = useCallback(({ data, label, fileName, warnings, message }: AcceptArgs) => {
    const hasTabs = countTabs(data) > 0;
    const hasBookmarks = countBookmarks(data.bookmarks) > 0;
    if (!hasTabs && !hasBookmarks) {
      setFileInfo({ text: t('fileEmpty'), tone: TONE.warning });
      return;
    }
    seq.current += 1;
    setLocked(null);
    setCandidate({ id: seq.current, data, hasTabs, hasBookmarks, label, ...(fileName ? { fileName } : {}), warnings });
    setFileInfo({ text: message, tone: TONE.success });
  }, []);

  return { candidate, locked, setLocked, fileInfo, setFileInfo, importMessage, setImportMessage, reset, accept };
}

export type ImportCandidateApi = ReturnType<typeof useImportCandidate>;
