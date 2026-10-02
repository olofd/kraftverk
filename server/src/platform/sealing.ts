import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

import { isSealed, PASSPHRASE_MIN, type PassphraseSealing } from '@kraftverk/hub';

/*
  A secret sealed with a passphrase, for an export that carries its secrets
  (docs/CONFIG.md): "sealed:v1:<salt>:<iv>:<data>", base64url, the key from
  the passphrase by scrypt and the seal AES-256-GCM — the same cipher the
  database seals its secrets with (`secrets.ts`), keyed by what its owner
  typed rather than by the server's key, so the file opens on any kraftverk
  that is given the passphrase, and on none that is not. The hub asks for
  it as a port (`PassphraseSealing`): this is the server's.
*/

const PREFIX = 'sealed:v1:';
/** scrypt's cost: about a tenth of a second a secret, on a small server. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

const keyOf = (passphrase: string, salt: Buffer) => scryptSync(passphrase.normalize('NFC'), salt, 32, SCRYPT);

/** A secret sealed with a passphrase. */
export function sealWith(passphrase: string, value: string): string {
  if (passphrase.length < PASSPHRASE_MIN) throw new RangeError(`A passphrase is at least ${PASSPHRASE_MIN} characters: an export travels`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyOf(passphrase, salt), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${PREFIX}${salt.toString('base64url')}:${iv.toString('base64url')}:${data.toString('base64url')}`;
}

/** A sealed secret opened with its passphrase. Throws when the passphrase is wrong or the value was changed. */
export function openWith(passphrase: string, sealed: string): string {
  if (!isSealed(sealed)) throw new Error('That is not a sealed secret');
  if (!sealed.startsWith(PREFIX)) throw new Error('That secret is sealed in a way this server does not know');
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

/** The server's passphrase sealing, as the hub asks for it. */
export const serverSealing: PassphraseSealing = {
  seal: async (passphrase, value) => sealWith(passphrase, value),
  open: async (passphrase, sealed) => openWith(passphrase, sealed),
};
