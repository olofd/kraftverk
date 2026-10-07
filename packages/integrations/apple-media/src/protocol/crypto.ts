import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha512 } from '@noble/hashes/sha2.js';

/*
  The cryptography Apple's pairing uses (HomeKit's, which the Apple TV's
  Companion and AirPlay protocols share): SHA-512, HKDF-SHA512, Ed25519,
  X25519 and ChaCha20-Poly1305 — from the noble libraries (MIT, audited,
  pure TypeScript, no dependencies), so the protocol stays pure and runs in
  the app as well as on a server.
*/

const encoder = new TextEncoder();
const bytesOf = (data: Uint8Array | string): Uint8Array => (typeof data === 'string' ? encoder.encode(data) : data);

export const sha512Of = (data: Uint8Array | string): Uint8Array => sha512(bytesOf(data));

/** HKDF-SHA512, as HomeKit derives each key: a named salt and info, 32 bytes. */
export const hkdfSha512 = (secret: Uint8Array, salt: string, info: string, length = 32): Uint8Array => hkdf(sha512, secret, bytesOf(salt), bytesOf(info), length);

/** An Ed25519 key pair: the long-term identity a pairing is made with. */
export function ed25519Pair(secret: Uint8Array = ed25519.utils.randomSecretKey()): { secret: Uint8Array; public: Uint8Array } {
  return { secret, public: ed25519.getPublicKey(secret) };
}

export const ed25519Sign = (message: Uint8Array, secret: Uint8Array): Uint8Array => ed25519.sign(message, secret);
export const ed25519Verify = (signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean => {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
};

/** An X25519 key pair for one verification: thrown away after. */
export function x25519Pair(secret: Uint8Array = x25519.utils.randomSecretKey()): { secret: Uint8Array; public: Uint8Array } {
  return { secret, public: x25519.getPublicKey(secret) };
}

export const x25519Shared = (secret: Uint8Array, theirs: Uint8Array): Uint8Array => x25519.getSharedSecret(secret, theirs);

/** A nonce of 12 bytes: one shorter is padded with zeros on the left, as HomeKit's named nonces ("PS-Msg05") are. */
function nonceOf(nonce: Uint8Array | string): Uint8Array {
  const bytes = bytesOf(nonce);
  if (bytes.length >= 12) return bytes.subarray(0, 12);
  const padded = new Uint8Array(12);
  padded.set(bytes, 12 - bytes.length);
  return padded;
}

/** ChaCha20-Poly1305: sealed, the 16-byte tag after the ciphertext. */
export const seal = (key: Uint8Array, nonce: Uint8Array | string, plain: Uint8Array, aad?: Uint8Array): Uint8Array => chacha20poly1305(key, nonceOf(nonce), aad).encrypt(plain);

/** Opened, or null when it is not what was sealed with this key: a wrong PIN, a tampered frame. */
export function open(key: Uint8Array, nonce: Uint8Array | string, sealed: Uint8Array, aad?: Uint8Array): Uint8Array | null {
  try {
    return chacha20poly1305(key, nonceOf(nonce), aad).decrypt(sealed);
  } catch {
    return null;
  }
}

/** Random bytes, as many as asked. */
export const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));
