import { beforeEach, describe, expect, test } from 'bun:test';

import { clearPreference, readPreference, writePreference } from '../lib/preferences';
import { legacySecrets, SecretVault, type KeyProvider } from './vault';

/*
  The app's secrets at rest: sealed under a key the browser will not give up,
  so what storage holds is ciphertext. Bun has the browser's crypto but not
  IndexedDB, so the test holds the key the way IndexedDB would.
*/

const STORAGE = 'test.vault';
let key: CryptoKey | null = null;
const keys: KeyProvider = async () => (key ??= await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));

beforeEach(() => {
  key = null;
  clearPreference(STORAGE);
  clearPreference('test.legacy');
});

describe('the vault', () => {
  test('what storage holds is ciphertext, and it opens again with the same key', async () => {
    const vault = new SecretVault({ storageKey: STORAGE, keys });
    await vault.ready();
    vault.set('c-1', { localKey: 'k3ym557nqw3p8p7m' });
    await vault.flushed();
    expect(readPreference(STORAGE)).not.toContain('k3ym557nqw3p8p7m');

    const reopened = new SecretVault({ storageKey: STORAGE, keys });
    await reopened.ready();
    expect(reopened.get('c-1')).toEqual({ localKey: 'k3ym557nqw3p8p7m' });
  });

  test('without a key it keeps secrets in memory only — never written down', async () => {
    const vault = new SecretVault({ storageKey: STORAGE, keys: async () => null });
    await vault.ready();
    vault.set('c-1', { localKey: 'secret' });
    await vault.flushed();
    expect(vault.get('c-1')).toEqual({ localKey: 'secret' });
    expect(readPreference(STORAGE)).toBeNull();
  });

  test('plaintext from before moves in, sealed, and the plaintext is gone', async () => {
    writePreference('test.legacy', JSON.stringify({ 'c-9': { localKey: 'old' } }));
    const vault = new SecretVault({ storageKey: STORAGE, keys, ...legacySecrets('test.legacy') });
    await vault.ready();
    expect(vault.get('c-9')).toEqual({ localKey: 'old' });
    expect(readPreference('test.legacy')).toBeNull();
    expect(readPreference(STORAGE)).not.toContain('old');
  });

  test('changing one secret keeps the others; deleting a connection forgets its own', async () => {
    const vault = new SecretVault({ storageKey: STORAGE, keys });
    vault.set('c-1', { a: '1', b: '2' });
    vault.set('c-1', { b: '3' });
    vault.set('c-2', { a: 'x' });
    vault.delete('c-2');
    await vault.flushed();
    const reopened = new SecretVault({ storageKey: STORAGE, keys });
    await reopened.ready();
    expect(reopened.get('c-1')).toEqual({ a: '1', b: '3' });
    expect(reopened.get('c-2')).toEqual({});
  });
});
