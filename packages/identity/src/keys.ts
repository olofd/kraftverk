import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { base64url, canonical, fromBase64url, utf8 } from './bytes.ts';
import { subtle, type WebCryptoPair } from './web-crypto.ts';

/** A P-256 public key, as a JWK: what a family keeps of a person's key, and a file carries. */
export type PublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

/** A key on one of a person's devices, or the one their recovery words make. */
export type KeyKind = 'device' | 'recovery';

/**
 * A key that signs: the port each platform fills (docs/PLAN-WORLD-MODEL.md
 * §10). Its private half stays where its platform keeps it — Web Crypto,
 * not extractable, in a browser; the keystore on a phone — and only
 * signatures leave: ECDSA over SHA-256, as r ‖ s, 64 bytes.
 */
export interface SigningKey {
  readonly publicJwk: PublicJwk;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

/** A key's id: `k-` and its RFC 7638 thumbprint, so the same key always has the same id. */
export function keyId(jwk: PublicJwk): string {
  return `k-${base64url(sha256(utf8(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))))}`;
}

/** The uncompressed point of a JWK, if it is one on the curve. */
function pointOf(jwk: PublicJwk): Uint8Array | null {
  const [x, y] = [fromBase64url(jwk.x), fromBase64url(jwk.y)];
  if (!x || !y || x.length !== 32 || y.length !== 32) return null;
  const bytes = new Uint8Array(65);
  bytes[0] = 4;
  bytes.set(x, 1);
  bytes.set(y, 33);
  try {
    p256.Point.fromBytes(bytes).assertValidity();
    return bytes;
  } catch {
    return null;
  }
}

/** Whether a value is a P-256 public key as a JWK, its point on the curve — and nothing more: never a private half. */
export function isPublicJwk(value: unknown): value is PublicJwk {
  if (typeof value !== 'object' || value === null) return false;
  const jwk = value as Record<string, unknown>;
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || 'd' in jwk) return false;
  return pointOf(jwk as PublicJwk) !== null;
}

/**
 * Whether a signature is a key's over these bytes. Web Crypto does not keep
 * s low, so neither does this: a signature is checked as it was made.
 */
export function verify(jwk: PublicJwk, data: Uint8Array, signature: Uint8Array): boolean {
  const point = pointOf(jwk);
  if (!point || signature.length !== 64) return false;
  try {
    return p256.verify(signature, data, point, { lowS: false, prehash: true });
  } catch {
    return false;
  }
}

/** The public half of a private scalar, as a JWK. */
export function publicJwkOf(secret: Uint8Array): PublicJwk {
  const point = p256.getPublicKey(secret, false);
  return { kty: 'EC', crv: 'P-256', x: base64url(point.slice(1, 33)), y: base64url(point.slice(33, 65)) };
}

/** A new private scalar: for a key kept as bytes — a phone's, in its keystore — or made from recovery words. */
export const newSecret = (): Uint8Array => p256.utils.randomSecretKey();

/** A key whose private half is bytes held in memory while it signs: a phone's, read from its keystore, or the recovery key. */
export function softwareKey(secret: Uint8Array): SigningKey {
  const publicJwk = publicJwkOf(secret);
  return { publicJwk, sign: async (data) => p256.sign(data, secret, { prehash: true }) };
}

/** A key that is a Web Crypto pair: its private half not extractable, kept as the object it is (IndexedDB holds one). */
export async function webCryptoKey(pair: WebCryptoPair): Promise<SigningKey> {
  const exported = await subtle().exportKey('jwk', pair.publicKey);
  const publicJwk: PublicJwk = { kty: 'EC', crv: 'P-256', x: exported.x!, y: exported.y! };
  return {
    publicJwk,
    sign: async (data) => new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, data as Uint8Array<ArrayBuffer>)),
  };
}

/** A new Web Crypto pair whose private half can never be read: a browser's key. */
export const newWebCryptoPair = (): Promise<WebCryptoPair> => subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
