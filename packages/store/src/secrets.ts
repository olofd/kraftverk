import { gcm } from '@noble/ciphers/aes.js';
import { scrypt } from '@noble/hashes/scrypt.js';

/**
 * How a connection's secrets are kept at rest: what the place keeping a home
 * provides (docs/PLAN-SHARED-CORE.md). The server seals with a key from its
 * environment, or keeps them as given when it has none and says so; a phone
 * with a key it keeps in its secure storage.
 */
export interface SecretsAtRest {
  /** Whether what is sealed now is encrypted: what a screen says of where secrets are kept. */
  readonly encrypted: boolean;
  seal(value: string): { value: string; encrypted: boolean };
  /** The value again; null when it cannot be opened — sealed with a key no longer here. */
  open(stored: string, encrypted: boolean): string | null;
}

/** Secrets kept as given: a test's, or a place with nothing to seal them with. */
export const plainSecrets: SecretsAtRest = {
  encrypted: false,
  seal: (value) => ({ value, encrypted: false }),
  open: (stored, encrypted) => (encrypted ? null : stored),
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/**
 * A key for secrets at rest from a passphrase: scrypt (N 2^14, r 8, p 1) over
 * a fixed salt — slow on purpose, so made once. What a server given
 * `KRAFTVERK_SECRET_KEY` seals with.
 */
export const secretKeyFrom = (passphrase: string): Uint8Array => scrypt(encoder.encode(passphrase), encoder.encode('kraftverk-secrets'), { N: 2 ** 14, r: 8, p: 1, dkLen: 32 });

/**
 * A connection's secrets sealed at rest with `key` (32 bytes): AES-256-GCM in
 * plain JavaScript (@noble/ciphers — audited, no dependencies), the same on a
 * server, a phone and in a browser's worker, written `<iv>.<tag>.<data>` in
 * base64. The key is the place's to keep: a server's from its passphrase, a
 * phone's in its secure storage, a browser's in a key it cannot export.
 */
export function sealedWithKey(key: Uint8Array): SecretsAtRest {
  if (key.length !== 32) throw new RangeError('A key for secrets at rest is 32 bytes');
  return {
    encrypted: true,
    seal: (value) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = gcm(key, iv).encrypt(encoder.encode(value));
      const data = sealed.subarray(0, sealed.length - 16);
      const tag = sealed.subarray(sealed.length - 16);
      return { value: `${toBase64(iv)}.${toBase64(tag)}.${toBase64(data)}`, encrypted: true };
    },
    open: (stored, encrypted) => {
      if (!encrypted) return stored;
      const [iv, tag, data] = stored.split('.');
      if (!iv || !tag || data === undefined) return null;
      try {
        const sealed = fromBase64(data);
        const whole = new Uint8Array(sealed.length + 16);
        whole.set(sealed);
        whole.set(fromBase64(tag), sealed.length);
        return decoder.decode(gcm(key, fromBase64(iv)).decrypt(whole));
      } catch {
        // Sealed with a key no longer here, or changed: asked for again.
        return null;
      }
    },
  };
}
