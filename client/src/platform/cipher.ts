import { gcm } from '@noble/ciphers/aes.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';

import { isSealed, PASSPHRASE_MIN, type PassphraseSealing } from '@kraftverk/hub';
import type { SecretsAtRest } from '@kraftverk/store';

/*
  The app's cipher, for a home it keeps itself — on a phone, and in a
  browser's worker alike: AES-256-GCM in plain JavaScript (@noble/ciphers,
  audited, with no dependencies), because a phone has no Web Crypto and a
  store's secrets are sealed as they are written, without waiting.
*/

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const random = (bytes: number) => crypto.getRandomValues(new Uint8Array(bytes));

const toBase64Url = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));

/**
 * A connection's secrets sealed at rest with `key` (32 bytes), kept where
 * the platform keeps what must not be read: a phone's secure storage, a
 * browser's key it cannot export. The database holds only what is sealed.
 */
export function sealedWithKey(key: Uint8Array): SecretsAtRest {
  if (key.length !== 32) throw new RangeError('A key for secrets at rest is 32 bytes');
  return {
    encrypted: true,
    seal: (value) => {
      const iv = random(12);
      return { value: `${toBase64Url(iv)}:${toBase64Url(gcm(key, iv).encrypt(encoder.encode(value)))}`, encrypted: true };
    },
    open: (stored, encrypted) => {
      if (!encrypted) return stored;
      const [iv, data] = stored.split(':');
      if (!iv || !data) return null;
      try {
        return decoder.decode(gcm(key, fromBase64Url(iv)).decrypt(fromBase64Url(data)));
      } catch {
        // Sealed with a key no longer here: asked for again.
        return null;
      }
    },
  };
}

/*
  A secret sealed with a passphrase, for an export that carries its secrets
  (docs/CONFIG.md): the server's own format, "sealed:v1:<salt>:<iv>:<data>",
  base64url, the key from the passphrase by scrypt (N 2^15, r 8, p 1) and
  the seal AES-256-GCM — so an export sealed by a server opens here, and one
  sealed here opens on a server.
*/
const PREFIX = 'sealed:v1:';
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, dkLen: 32 } as const;

const keyOf = (passphrase: string, salt: Uint8Array) => scryptAsync(encoder.encode(passphrase.normalize('NFC')), salt, SCRYPT);

export const appSealing: PassphraseSealing = {
  seal: async (passphrase, value) => {
    if (passphrase.length < PASSPHRASE_MIN) throw new RangeError(`A passphrase is at least ${PASSPHRASE_MIN} characters: an export travels`);
    const salt = random(16);
    const iv = random(12);
    const data = gcm(await keyOf(passphrase, salt), iv).encrypt(encoder.encode(value));
    return `${PREFIX}${toBase64Url(salt)}:${toBase64Url(iv)}:${toBase64Url(data)}`;
  },
  open: async (passphrase, sealed) => {
    if (!isSealed(sealed)) throw new Error('That is not a sealed secret');
    if (!sealed.startsWith(PREFIX)) throw new Error('That secret is sealed in a way this app does not know');
    const [salt, iv, data] = sealed.slice(PREFIX.length).split(':').map(fromBase64Url);
    if (!salt?.length || !iv?.length || !data || data.length < 16) throw new Error('That sealed secret is not whole');
    try {
      return decoder.decode(gcm(await keyOf(passphrase, salt), iv).decrypt(data));
    } catch {
      throw new Error('The passphrase does not open it: a different passphrase, or a sealed value that was changed');
    }
  },
};
