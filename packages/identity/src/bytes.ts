import { sha256 } from '@noble/hashes/sha2.js';

/** A value that has one form as text: what is signed is that form, so two places that build it agree byte for byte. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/**
 * A value as canonical JSON: keys in order, no spaces, numbers as JSON
 * writes them. What a signature covers — the same statement built anywhere
 * is the same bytes.
 */
export function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('A number that is signed is finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((each) => canonical(each as Json)).join(',')}]`;
  const record = value as { readonly [key: string]: Json };
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key]!)}`)
    .join(',')}}`;
}

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Bytes as base64url, unpadded: what a JWK and a signature are written in. */
export function base64url(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const [a, b, c] = [bytes[index]!, bytes[index + 1], bytes[index + 2]];
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += ALPHABET[c & 63]!;
  }
  return out;
}

/** Base64url back to bytes; null for anything that is not. */
export function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text) {
    buffer = (buffer << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

/** The SHA-256 of a value's canonical form, as base64url: what a statement's successor points back at. */
export const hashOf = (value: Json): string => base64url(sha256(utf8(canonical(value))));
