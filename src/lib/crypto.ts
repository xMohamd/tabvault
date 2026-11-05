/**
 * Password protection for backup files (WebCrypto only; works in the service worker,
 * the Firefox background page, the popup and Node).
 *
 * File format: a plain JSON envelope holding PBKDF2-HMAC-SHA256 parameters and an
 * AES-256-GCM ciphertext of the backup JSON. The password is never stored.
 */

export const ENCRYPTED_FORMAT = 'tabvault-encrypted';
export const ENVELOPE_VERSION = 1;
export const DEFAULT_ITERATIONS = 600_000;
/** Decryption honours the file's iteration count, up to this cap (a hostile file must not hang the UI). */
export const MAX_ITERATIONS = 10_000_000;
export const MIN_PASSWORD_LENGTH = 8;

const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface EncryptedEnvelope {
  format: typeof ENCRYPTED_FORMAT;
  version: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  data: string;
}

/** Thrown when the password is wrong or the ciphertext was modified (AES-GCM cannot tell them apart). */
export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password.');
    this.name = 'WrongPasswordError';
  }
}

/** Thrown when the envelope is malformed or uses parameters this version does not support. */
export class EncryptedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptedFormatError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** True for anything that claims to be an encrypted backup (the version is checked on decrypt). */
export function isEncryptedEnvelope(json: unknown): json is EncryptedEnvelope {
  return isRecord(json) && json.format === ENCRYPTED_FORMAT;
}

// ---------- base64 (chunked: spreading a large array into fromCharCode overflows the stack) ----------

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw new EncryptedFormatError('The encrypted file is damaged (invalid encoding).');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------- crypto ----------

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  const material = await subtle.importKey('raw', new TextEncoder().encode(password.normalize('NFKC')), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** @param options.iterations PBKDF2 cost; only tests lower it. */
export async function encryptBackup(
  json: string,
  password: string,
  options: { iterations?: number } = {},
): Promise<EncryptedEnvelope> {
  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new EncryptedFormatError('Invalid iteration count.');
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt, iterations);
  const cipher = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json));
  return {
    format: ENCRYPTED_FORMAT,
    version: ENVELOPE_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: bytesToBase64(salt) },
    cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) },
    data: bytesToBase64(new Uint8Array(cipher)),
  };
}

/** Validates the envelope and returns its decoded parts. */
function readEnvelope(envelope: unknown) {
  if (!isEncryptedEnvelope(envelope)) throw new EncryptedFormatError('This is not an encrypted backup.');
  const { version, kdf, cipher, data } = envelope as unknown as Record<string, unknown>;
  if (version !== ENVELOPE_VERSION) {
    throw new EncryptedFormatError(`Unsupported encrypted backup version: ${String(version)}.`);
  }
  if (!isRecord(kdf) || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') {
    throw new EncryptedFormatError('Unsupported key derivation in the encrypted backup.');
  }
  if (!isRecord(cipher) || cipher.name !== 'AES-GCM') {
    throw new EncryptedFormatError('Unsupported cipher in the encrypted backup.');
  }
  const iterations = kdf.iterations;
  if (typeof iterations !== 'number' || !Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    throw new EncryptedFormatError('The encrypted backup has an invalid iteration count.');
  }
  if (typeof kdf.salt !== 'string' || typeof cipher.iv !== 'string' || typeof data !== 'string') {
    throw new EncryptedFormatError('The encrypted backup is incomplete.');
  }
  const salt = base64ToBytes(kdf.salt);
  const iv = base64ToBytes(cipher.iv);
  if (salt.length < 8 || iv.length !== IV_BYTES) throw new EncryptedFormatError('The encrypted backup is damaged.');
  return { iterations, salt, iv, bytes: base64ToBytes(data) };
}

/** @throws {WrongPasswordError} on a wrong password or modified data; {EncryptedFormatError} for unusable files */
export async function decryptBackup(envelope: EncryptedEnvelope, password: string): Promise<string> {
  const { iterations, salt, iv, bytes } = readEnvelope(envelope);
  const key = await deriveKey(password, salt, iterations);
  let plain: ArrayBuffer;
  try {
    plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes);
  } catch {
    throw new WrongPasswordError();
  }
  return new TextDecoder().decode(plain);
}
