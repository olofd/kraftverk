/*
  Web Crypto, where a place has it: a browser and a server do, a phone's
  Hermes does not. Typed here as far as this package uses it, so the
  package checks under the everywhere-typing of a phone, where `crypto` is
  only `getRandomValues`; what needs it says so where it is missing.
*/

/** A key Web Crypto holds: opaque, its private half perhaps never readable. */
export type WebCryptoKey = object;
export type WebCryptoPair = { publicKey: WebCryptoKey; privateKey: WebCryptoKey };

type Bytes = Uint8Array<ArrayBuffer>;

type Subtle = {
  generateKey(algorithm: object, extractable: boolean, usages: string[]): Promise<WebCryptoPair>;
  exportKey(format: 'jwk', key: WebCryptoKey): Promise<{ x?: string; y?: string }>;
  importKey(format: 'jwk', key: object, algorithm: object, extractable: boolean, usages: string[]): Promise<WebCryptoKey>;
  sign(algorithm: object, key: WebCryptoKey, data: Bytes): Promise<ArrayBuffer>;
  verify(algorithm: object | string, key: WebCryptoKey, signature: Bytes, data: Bytes): Promise<boolean>;
};

/** Web Crypto here; refused where there is none. */
export function subtle(): Subtle {
  const found = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  if (!found) throw new Error('Web Crypto is not here: this place cannot do that');
  return found;
}
