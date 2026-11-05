import { describe, expect, it } from 'vitest';
import {
  bytesToBase64,
  base64ToBytes,
  decryptBackup,
  EncryptedFormatError,
  encryptBackup,
  isEncryptedEnvelope,
  MAX_ITERATIONS,
  WrongPasswordError,
  type EncryptedEnvelope,
} from '@/lib/crypto';
import { EncryptedBackupError, parseBackupFile } from '@/lib/formats';

const FAST = { iterations: 1000 };
const JSON_TEXT = JSON.stringify({ schemaVersion: '1.1', windows: [], bookmarks: [{ title: 'ünï', url: 'https://x.example/' }] });

describe('encryptBackup / decryptBackup', () => {
  it('round-trips and writes the documented envelope', async () => {
    const env = await encryptBackup(JSON_TEXT, 'correct horse', FAST);
    expect(env).toMatchObject({
      format: 'tabvault-encrypted',
      version: 1,
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 1000 },
      cipher: { name: 'AES-GCM' },
    });
    expect(base64ToBytes(env.kdf.salt)).toHaveLength(16);
    expect(base64ToBytes(env.cipher.iv)).toHaveLength(12);
    expect(env.data).not.toContain('example');
    expect(await decryptBackup(JSON.parse(JSON.stringify(env)), 'correct horse')).toBe(JSON_TEXT);
  });

  it('defaults to 600000 iterations', async () => {
    // Cost is real here (~0.5s) but pins the documented default.
    const env = await encryptBackup('{}', 'password1');
    expect(env.kdf.iterations).toBe(600_000);
  });

  it('uses a fresh salt and iv per file', async () => {
    const a = await encryptBackup(JSON_TEXT, 'password1', FAST);
    const b = await encryptBackup(JSON_TEXT, 'password1', FAST);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.data).not.toBe(b.data);
  });

  it('rejects a wrong password', async () => {
    const env = await encryptBackup(JSON_TEXT, 'right-password', FAST);
    await expect(decryptBackup(env, 'wrong-password')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('rejects tampered data', async () => {
    const env = await encryptBackup(JSON_TEXT, 'right-password', FAST);
    const bytes = base64ToBytes(env.data);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await expect(decryptBackup({ ...env, data: bytesToBase64(bytes) }, 'right-password')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('rejects unknown versions and algorithms', async () => {
    const env = await encryptBackup(JSON_TEXT, 'right-password', FAST);
    const bad = (patch: Record<string, unknown>) => decryptBackup({ ...env, ...patch } as unknown as EncryptedEnvelope, 'right-password');
    await expect(bad({ version: 2 })).rejects.toBeInstanceOf(EncryptedFormatError);
    await expect(bad({ kdf: { ...env.kdf, name: 'scrypt' } })).rejects.toThrow(/key derivation/);
    await expect(bad({ kdf: { ...env.kdf, hash: 'SHA-1' } })).rejects.toBeInstanceOf(EncryptedFormatError);
    await expect(bad({ cipher: { ...env.cipher, name: 'AES-CBC' } })).rejects.toThrow(/cipher/);
    await expect(bad({ data: 5 })).rejects.toBeInstanceOf(EncryptedFormatError);
    await expect(bad({ data: '***' })).rejects.toBeInstanceOf(EncryptedFormatError);
  });

  it('refuses iteration counts above the cap (and nonsense) without deriving a key', async () => {
    const env = await encryptBackup(JSON_TEXT, 'right-password', FAST);
    for (const iterations of [MAX_ITERATIONS + 1, 0, -5, 1.5, '1000', Infinity]) {
      const started = Date.now();
      await expect(
        decryptBackup({ ...env, kdf: { ...env.kdf, iterations } } as unknown as EncryptedEnvelope, 'right-password'),
      ).rejects.toBeInstanceOf(EncryptedFormatError);
      expect(Date.now() - started).toBeLessThan(500);
    }
    await expect(encryptBackup('{}', 'x', { iterations: MAX_ITERATIONS + 1 })).rejects.toBeInstanceOf(EncryptedFormatError);
  });

  it('honours the iteration count stored in the file', async () => {
    const env = await encryptBackup(JSON_TEXT, 'right-password', { iterations: 1000 });
    // Same ciphertext, different claimed cost -> different key -> authentication failure.
    await expect(decryptBackup({ ...env, kdf: { ...env.kdf, iterations: 1001 } }, 'right-password')).rejects.toBeInstanceOf(WrongPasswordError);
  });

  it('handles a large payload', async () => {
    const big = JSON.stringify({ filler: 'é€😀'.repeat(700_000) }); // several MB, beyond any argument-spread limit
    const env = await encryptBackup(big, 'right-password', FAST);
    expect(await decryptBackup(env, 'right-password')).toBe(big);
  });

  it('chunked base64 matches btoa for large inputs', () => {
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
  });
});

describe('isEncryptedEnvelope', () => {
  it('detects by format marker only', () => {
    expect(isEncryptedEnvelope({ format: 'tabvault-encrypted' })).toBe(true);
    expect(isEncryptedEnvelope({ format: 'other' })).toBe(false);
    expect(isEncryptedEnvelope(null)).toBe(false);
    expect(isEncryptedEnvelope([])).toBe(false);
    expect(isEncryptedEnvelope('tabvault-encrypted')).toBe(false);
  });
});

describe('parseBackupFile with encrypted files', () => {
  it('throws EncryptedBackupError carrying the envelope instead of parsing it', async () => {
    const env = await encryptBackup(JSON_TEXT, 'right-password', FAST);
    try {
      parseBackupFile(JSON.stringify(env, null, 2));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EncryptedBackupError);
      expect((error as EncryptedBackupError).envelope).toEqual(env);
    }
  });

  it('parses the decrypted text like a normal file', async () => {
    const env = await encryptBackup(JSON_TEXT, 'right-password', FAST);
    const parsed = parseBackupFile(await decryptBackup(env, 'right-password'));
    expect(parsed.format).toBe('native');
    expect(parsed.data.bookmarks).toHaveLength(1);
  });
});
