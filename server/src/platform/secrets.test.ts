import { describe, expect, test } from 'bun:test';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { isSealed, passphraseSealing } from '@kraftverk/hub';

import { serverSecrets } from './secrets.ts';

/*
  The server seals with the one cipher every place shares (\`@kraftverk/store\`'s
  secrets at rest, the hub's passphrase sealing) — and what a server sealed
  before, with the runtime's own crypto, still opens: a database's secrets,
  the configuration kept beside it (\`sealed:server:…\`), and an export sealed
  with a passphrase. The reference below is that earlier code, as it was.
*/

/** Secrets at rest as the server sealed them with node:crypto: "<iv>.<tag>.<data>", base64, the key by scrypt from the passphrase. */
const before = {
  key: (passphrase: string) => scryptSync(passphrase, 'kraftverk-secrets', 32),
  seal(passphrase: string, value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(passphrase), iv);
    const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${sealed.toString('base64')}`;
  },
  open(passphrase: string, stored: string): string {
    const [iv, tag, payload] = stored.split('.');
    const decipher = createDecipheriv('aes-256-gcm', this.key(passphrase), Buffer.from(iv!, 'base64'));
    decipher.setAuthTag(Buffer.from(tag!, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload!, 'base64')), decipher.final()]).toString('utf8');
  },
};

/** A secret sealed with a passphrase as the server sealed it: "sealed:v1:<salt>:<iv>:<data+tag>", base64url, scrypt N 2^15. */
const sealedBefore = {
  key: (passphrase: string, salt: Buffer) => scryptSync(passphrase.normalize('NFC'), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }),
  seal(passphrase: string, value: string): string {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(passphrase, salt), iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return `sealed:v1:${salt.toString('base64url')}:${iv.toString('base64url')}:${data.toString('base64url')}`;
  },
  open(passphrase: string, sealed: string): string {
    const [salt, iv, data] = sealed.slice('sealed:v1:'.length).split(':').map((part) => Buffer.from(part, 'base64url'));
    const decipher = createDecipheriv('aes-256-gcm', this.key(passphrase, salt!), iv!);
    decipher.setAuthTag(data!.subarray(data!.length - 16));
    return Buffer.concat([decipher.update(data!.subarray(0, data!.length - 16)), decipher.final()]).toString('utf8');
  },
};

const KEY = 'a passphrase for these tests only';

describe("the server's secrets at rest", () => {
  test('what the server sealed before opens now, and what it seals now opens as before', () => {
    const secrets = serverSecrets(KEY);
    expect(secrets.encrypted).toBe(true);
    expect(secrets.open(before.seal(KEY, 'local-key-of-a-test'), true)).toBe('local-key-of-a-test');
    const sealed = secrets.seal('local-key-of-a-test');
    expect(sealed.encrypted).toBe(true);
    expect(before.open(KEY, sealed.value)).toBe('local-key-of-a-test');
  });

  test('another key opens nothing; with none, secrets are kept as given and it says so', () => {
    expect(serverSecrets('another passphrase altogether').open(serverSecrets(KEY).seal('x').value, true)).toBeNull();
    const plain = serverSecrets(null);
    expect(plain.encrypted).toBe(false);
    expect(plain.seal('x')).toEqual({ value: 'x', encrypted: false });
    expect(plain.open(before.seal(KEY, 'x'), true)).toBeNull();
  });
});

describe('a secret sealed with a passphrase', () => {
  const passphrase = 'correct horse battery staple';

  test('one the server sealed before opens now, and one sealed now opens as before', async () => {
    expect(await passphraseSealing.open(passphrase, sealedBefore.seal(passphrase, 'local-key-of-a-test'))).toBe('local-key-of-a-test');
    const sealed = await passphraseSealing.seal(passphrase, 'local-key-of-a-test');
    expect(isSealed(sealed)).toBe(true);
    expect(sealedBefore.open(passphrase, sealed)).toBe('local-key-of-a-test');
  });

  test('does not open with another passphrase, nor once changed; a short one is refused', async () => {
    const sealed = await passphraseSealing.seal(passphrase, 'local-key-of-a-test');
    expect(sealed).not.toBe(await passphraseSealing.seal(passphrase, 'local-key-of-a-test'));
    await expect(passphraseSealing.open('another passphrase entirely', sealed)).rejects.toThrow('The passphrase does not open it');
    const changed = sealed.slice(0, -2) + (sealed.endsWith('A') ? 'BB' : 'AA');
    await expect(passphraseSealing.open(passphrase, changed)).rejects.toThrow('The passphrase does not open it');
    await expect(passphraseSealing.open(passphrase, 'not sealed at all')).rejects.toThrow('That is not a sealed secret');
    await expect(passphraseSealing.seal('short', 'x')).rejects.toThrow('at least 12 characters');
  });
});
