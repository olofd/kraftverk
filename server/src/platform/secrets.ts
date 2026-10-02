import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import type { SecretsAtRest } from '@kraftverk/store';

/**
 * How the server keeps a connection's secrets at rest: encrypted only if a
 * key is supplied from outside.
 *
 * With `KRAFTVERK_SECRET_KEY` set, values are AES-256-GCM sealed. Without it
 * they are stored as given — and `encrypted` says so plainly, so the app can
 * say so, because a key kept next to the data it protects would be decoration
 * rather than encryption.
 */

/*
  Derived once per passphrase. scrypt is slow on purpose and synchronous here,
  and it ran on every secret read — and on every poll of a list of devices,
  just to learn whether a key exists — stalling the whole server each time.
*/
let derived: { passphrase: string; key: Buffer } | null = null;

const secretKey = (): Buffer | null => {
  const passphrase = process.env.KRAFTVERK_SECRET_KEY;
  if (!passphrase) return null;
  if (derived?.passphrase !== passphrase) derived = { passphrase, key: scryptSync(passphrase, 'kraftverk-secrets', 32) };
  return derived.key;
};

export const secretsAreEncrypted = (): boolean => Boolean(process.env.KRAFTVERK_SECRET_KEY);

export function sealSecret(value: string): { value: string; encrypted: boolean } {
  const key = secretKey();
  if (!key) return { value, encrypted: false };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { value: `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${sealed.toString('base64')}`, encrypted: true };
}

export function openSecret(stored: string, encrypted: boolean): string | null {
  if (!encrypted) return stored;
  const key = secretKey();
  if (!key) return null; // sealed with a key that is no longer present
  const [iv, tag, payload] = stored.split('.');
  if (!iv || !tag || !payload) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(payload, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** The server's secrets at rest, as the store asks for them. */
export const serverSecrets: SecretsAtRest = {
  get encrypted() {
    return secretsAreEncrypted();
  },
  seal: sealSecret,
  open: openSecret,
};
