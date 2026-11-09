/**
 * The folder the user chose for automatic backup files (Chromium only).
 *
 * The File System Access API gives a directory handle from showDirectoryPicker().
 * Handles are structured-cloneable but cannot go in browser.storage, so the
 * handle lives in the extension's IndexedDB, where both the popup (which picks
 * it) and the background (which writes into it) can read it.
 *
 * Firefox has no directory picker; there backup files can only go into a folder
 * inside Downloads (see ScheduleSettings.downloadsFolder).
 */
import { logger } from './logger';

const DB_NAME = 'tabvault';
const STORE = 'handles';
const KEY = 'backupFolder';

export interface BackupFolder {
  /** Changes on every pick; files remember it so pruning only touches the folder they were written to. */
  id: string;
  handle: FileSystemDirectoryHandle;
}

export type FolderAccess = 'granted' | 'prompt' | 'denied';

/** The directory picker exists (Chromium desktop; not Firefox, and not Brave by default). */
export function folderPickerSupported(): boolean {
  return typeof globalThis !== 'undefined' && typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export async function getBackupFolder(): Promise<BackupFolder | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const value = await withStore<unknown>('readonly', (store) => store.get(KEY));
    const folder = value as Partial<BackupFolder> | undefined;
    return folder && typeof folder.id === 'string' && folder.handle ? (folder as BackupFolder) : null;
  } catch (error) {
    logger.warn('BACKUP_FOLDER_READ_FAILED', {}, error);
    return null;
  }
}

/** Stores a newly picked folder and returns it with a fresh id. */
export async function setBackupFolder(handle: FileSystemDirectoryHandle): Promise<BackupFolder> {
  const folder: BackupFolder = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, handle };
  await withStore('readwrite', (store) => store.put(folder, KEY));
  return folder;
}

export async function clearBackupFolder(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await withStore('readwrite', (store) => store.delete(KEY));
}

type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
};

/** Whether the extension may write to the folder now, without asking. */
export async function folderAccess(handle: FileSystemDirectoryHandle): Promise<FolderAccess> {
  const query = (handle as PermissionHandle).queryPermission;
  if (!query) return 'granted';
  try {
    return await query.call(handle, { mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/** Asks the user to allow writing again. Needs a click (user activation) in a page. */
export async function requestFolderAccess(handle: FileSystemDirectoryHandle): Promise<FolderAccess> {
  const request = (handle as PermissionHandle).requestPermission;
  if (!request) return 'granted';
  return request.call(handle, { mode: 'readwrite' });
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** Writes `text` as a new file; a taken name gets " (1)", " (2)"… like a download. @returns the name used */
export async function writeFolderFile(dir: FileSystemDirectoryHandle, name: string, text: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let finalName = name;
  for (let n = 1; (await exists(dir, finalName)) && n < 100; n++) finalName = `${base} (${n})${ext}`;
  const file = await dir.getFileHandle(finalName, { create: true });
  const writable = await file.createWritable();
  try {
    await writable.write(text);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  return finalName;
}

export async function removeFolderFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  await dir.removeEntry(name);
}
