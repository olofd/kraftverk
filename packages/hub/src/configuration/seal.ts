import { gcm } from '@noble/ciphers/aes.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';

import type { SecretsAtRest } from '@kraftverk/store';

/*
  Secrets in a configuration file (docs/CONFIG.md), as the hub reads and
  writes them: sealed with a passphrase for an export that travels, or kept
  as the home keeps its own for the snapshot beside its database.
*/

/** A passphrase shorter than this is refused: an export travels, and is guessed at offline. */
export const PASSPHRASE_MIN = 12;

/**
 * Sealing a secret with a passphrase, and opening it. Asynchronous, as a
 * key made from a passphrase is slow on purpose. `open` throws, in words,
 * when the passphrase is wrong or the value was changed. Every place seals
 * with `passphraseSealing`; a port still, so a test may stand in for it.
 */
export interface PassphraseSealing {
  seal(passphrase: string, value: string): Promise<string>;
  open(passphrase: string, sealed: string): Promise<string>;
}

/** Whether a secret in a file is sealed with a passphrase (`sealed:v1:…`), whichever version. */
export const isSealed = (value: string): boolean => /^sealed:v\d+:/.test(value);

/** A secret as the home's own snapshot keeps it: sealed as the database seals it. */
const KEPT = 'sealed:server:';

/**
 * A secret as the snapshot beside the database keeps it: sealed with the
 * home's key, as the database seals it ("sealed:server:…") — or, with none,
 * as the database keeps it. It opens only where it was kept, and never leaves.
 */
export function keep(secrets: SecretsAtRest, value: string): string {
  const sealed = secrets.seal(value);
  return sealed.encrypted ? `${KEPT}${sealed.value}` : value;
}

/** A secret the snapshot kept, opened; null when the key that sealed it is gone. */
export const openKept = (secrets: SecretsAtRest, value: string): string | null => (value.startsWith(KEPT) ? secrets.open(value.slice(KEPT.length), true) : value);

/** Whether a secret in a file is one the home kept for itself. */
export const isKept = (value: string): boolean => value.startsWith(KEPT);

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64Url = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));

/*
  A secret sealed with a passphrase, for an export that carries its secrets
  (docs/CONFIG.md): "sealed:v1:<salt>:<iv>:<data>", base64url, the key from
  the passphrase by scrypt (N 2^15, r 8, p 1) and the seal AES-256-GCM, in
  plain JavaScript (@noble — audited, no dependencies): the same on a server,
  a phone and in a browser's worker, so a file sealed on one opens on any
  given the passphrase, and on none that is not.
*/
const PREFIX = 'sealed:v1:';
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;

const keyOf = (passphrase: string, salt: Uint8Array) => scryptAsync(encoder.encode(passphrase.normalize('NFC')), salt, SCRYPT);

export const passphraseSealing: PassphraseSealing = {
  seal: async (passphrase, value) => {
    if (passphrase.length < PASSPHRASE_MIN) throw new RangeError(`A passphrase is at least ${PASSPHRASE_MIN} characters: an export travels`);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = gcm(await keyOf(passphrase, salt), iv).encrypt(encoder.encode(value));
    return `${PREFIX}${toBase64Url(salt)}:${toBase64Url(iv)}:${toBase64Url(data)}`;
  },
  open: async (passphrase, sealed) => {
    if (!isSealed(sealed)) throw new Error('That is not a sealed secret');
    if (!sealed.startsWith(PREFIX)) throw new Error('That secret is sealed in a way this kraftverk does not know');
    const [salt, iv, data] = sealed.slice(PREFIX.length).split(':').map(fromBase64Url);
    if (!salt?.length || !iv?.length || !data || data.length < 16) throw new Error('That sealed secret is not whole');
    try {
      return decoder.decode(gcm(await keyOf(passphrase, salt), iv).decrypt(data));
    } catch {
      throw new Error('The passphrase does not open it: a different passphrase, or a sealed value that was changed');
    }
  },
};
