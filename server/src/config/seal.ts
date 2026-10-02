import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { openSecret, sealSecret } from '../platform/secrets.ts';

/*
  A secret sealed with a passphrase, for an export that carries its secrets
  (docs/CONFIG.md): "sealed:v1:<salt>:<iv>:<data>", base64url, the key from
  the passphrase by scrypt and the seal AES-256-GCM — the same cipher the
  database seals its secrets with (`platform/secrets.ts`), keyed by what its owner
  typed rather than by the server's key, so the file opens on any kraftverk
  that is given the passphrase, and on none that is not.
*/

const PREFIX = 'sealed:v1:';
/** scrypt's cost: about a tenth of a second a secret, on a small server. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
/** A passphrase shorter than this is refused: an export travels, and is guessed at offline. */
export const PASSPHRASE_MIN = 12;

const keyOf = (passphrase: string, salt: Buffer) => scryptSync(passphrase.normalize('NFC'), salt, 32, SCRYPT);

export const isSealed = (value: string): boolean => value.startsWith(PREFIX);

/** A secret sealed with a passphrase. */
export function sealWith(passphrase: string, value: string): string {
  if (passphrase.length < PASSPHRASE_MIN) throw new RangeError(`A passphrase is at least ${PASSPHRASE_MIN} characters: an export travels`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${PREFIX}${salt.toString('base64url')}:${iv.toString('base64url')}:${data.toString('base64url')}`;
}

const KEPT = 'sealed:server:';

/**
 * A secret as the server's own snapshot keeps it: sealed with the server's
 * key, as the database seals it ("sealed:server:…") — or, with no key, as the
 * database keeps it. It opens only on this server, and never leaves it.
 */
export function keep(value: string): string {
  const sealed = sealSecret(value);
  return sealed.encrypted ? `${KEPT}${sealed.value}` : value;
}

/** A secret the snapshot kept, opened; null when the server's key that sealed it is gone. */
export const openKept = (value: string): string | null => (value.startsWith(KEPT) ? openSecret(value.slice(KEPT.length), true) : value);

/** A sealed secret opened with its passphrase. Throws when the passphrase is wrong or the value was changed. */
export function openWith(passphrase: string, sealed: string): string {
  if (!isSealed(sealed)) throw new Error('That is not a sealed secret');
  const [salt, iv, data] = sealed.slice(PREFIX.length).split(':').map((part) => Buffer.from(part, 'base64url'));
  if (!salt?.length || !iv?.length || !data || data.length < 16) throw new Error('That sealed secret is not whole');
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyOf(passphrase, salt), iv);
    decipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('The passphrase does not open it: a different passphrase, or a sealed value that was changed');
  }
}
