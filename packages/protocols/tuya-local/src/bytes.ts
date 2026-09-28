/**
 * Bytes, without Node's `Buffer`: the protocol runs wherever its connection is
 * held, and a phone has no `Buffer`. Small and boring on purpose.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const text = (bytes: Uint8Array): string => decoder.decode(bytes);
export const ascii = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const readU32 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;

export function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = (value >>> 24) & 0xff;
  out[1] = (value >>> 16) & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = value & 0xff;
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

export const toHex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []);

/** Random bytes from the platform's Web Crypto, which Bun, browsers and React Native all provide. */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}
