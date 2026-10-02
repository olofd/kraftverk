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

/**
 * The server's secrets at rest: sealed with a key made from `passphrase`
 * (`KRAFTVERK_SECRET_KEY`) — derived once, as scrypt is slow on purpose —
 * or, with none, kept as given, and `encrypted` says so.
 */
export function serverSecrets(passphrase: string | null): SecretsAtRest {
  const key = passphrase ? scryptSync(passphrase, 'kraftverk-secrets', 32) : null;
  return {
    encrypted: key !== null,
    seal(value) {
      if (!key) return { value, encrypted: false };
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return { value: `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${sealed.toString('base64')}`, encrypted: true };
    },
    open(stored, encrypted) {
      if (!encrypted) return stored;
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
    },
  };
}
