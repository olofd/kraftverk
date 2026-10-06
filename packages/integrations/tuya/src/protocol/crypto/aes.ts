import { concat, equal } from '../bytes.ts';

/**
 * AES-128, in the two modes the Tuya LAN protocol uses: ECB with PKCS#7
 * padding (3.1–3.4) and GCM (3.5).
 *
 * Written out rather than taken from the platform, because the platforms
 * disagree: Web Crypto has no ECB at all, and React Native has no Node
 * `crypto`. Payloads are a few hundred bytes, so a plain byte-oriented
 * implementation is plenty. It follows FIPS-197 and NIST SP 800-38D, and its
 * tests check it byte for byte against Node's own implementation.
 */

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
{
  // The S-box from its definition: the multiplicative inverse in GF(2^8),
  // followed by the affine transform.
  let p = 1;
  let q = 1;
  do {
    // p ← p · 3
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    // q ← q / 3
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const rotl = (x: number, n: number) => ((x << n) | (x >> (8 - n))) & 0xff;
    const value = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4) ^ 0x63;
    SBOX[p] = value;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]!] = i;
}

const xtime = (a: number) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;

function mul(a: number, b: number): number {
  let product = 0;
  while (b) {
    if (b & 1) product ^= a;
    a = xtime(a);
    b >>= 1;
  }
  return product;
}

/** The eleven round keys of AES-128, one after another. */
function expandKey(key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error(`An AES-128 key is 16 bytes, not ${key.length}`);
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4]!;
    let t1 = w[i - 3]!;
    let t2 = w[i - 2]!;
    let t3 = w[i - 1]!;
    if (i % 16 === 0) {
      // RotWord, SubWord, then the round constant.
      [t0, t1, t2, t3] = [SBOX[t1]! ^ rcon, SBOX[t2]!, SBOX[t3]!, SBOX[t0]!];
      rcon = xtime(rcon);
    }
    w[i] = w[i - 16]! ^ t0;
    w[i + 1] = w[i - 15]! ^ t1;
    w[i + 2] = w[i - 14]! ^ t2;
    w[i + 3] = w[i - 13]! ^ t3;
  }
  return w;
}

const addRoundKey = (s: Uint8Array, w: Uint8Array, round: number) => {
  for (let i = 0; i < 16; i++) s[i]! ^= w[round * 16 + i]!;
};

/** The state is column-major, as the bytes arrive: s[row + 4·column]. */
function shiftRows(s: Uint8Array): void {
  const t = s.slice();
  for (let r = 1; r < 4; r++) for (let c = 0; c < 4; c++) s[r + 4 * c] = t[r + 4 * ((c + r) % 4)]!;
}

function invShiftRows(s: Uint8Array): void {
  const t = s.slice();
  for (let r = 1; r < 4; r++) for (let c = 0; c < 4; c++) s[r + 4 * c] = t[r + 4 * ((c - r + 4) % 4)]!;
}

function mixColumns(s: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const [a0, a1, a2, a3] = [s[4 * c]!, s[4 * c + 1]!, s[4 * c + 2]!, s[4 * c + 3]!];
    s[4 * c] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;
    s[4 * c + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;
    s[4 * c + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);
    s[4 * c + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);
  }
}

function invMixColumns(s: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const [a0, a1, a2, a3] = [s[4 * c]!, s[4 * c + 1]!, s[4 * c + 2]!, s[4 * c + 3]!];
    s[4 * c] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
    s[4 * c + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
    s[4 * c + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
    s[4 * c + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
  }
}

function encryptBlock(block: Uint8Array, w: Uint8Array): Uint8Array {
  const s = block.slice(0, 16);
  addRoundKey(s, w, 0);
  for (let round = 1; round < 10; round++) {
    for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]!]!;
    shiftRows(s);
    mixColumns(s);
    addRoundKey(s, w, round);
  }
  for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]!]!;
  shiftRows(s);
  addRoundKey(s, w, 10);
  return s;
}

function decryptBlock(block: Uint8Array, w: Uint8Array): Uint8Array {
  const s = block.slice(0, 16);
  addRoundKey(s, w, 10);
  for (let round = 9; round > 0; round--) {
    invShiftRows(s);
    for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]!]!;
    addRoundKey(s, w, round);
    invMixColumns(s);
  }
  invShiftRows(s);
  for (let i = 0; i < 16; i++) s[i] = INV_SBOX[s[i]!]!;
  addRoundKey(s, w, 0);
  return s;
}

// --- ECB, with PKCS#7 padding ---------------------------------------------------

export function aesEcbEncrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const w = expandKey(key);
  const pad = 16 - (plaintext.length % 16);
  const padded = new Uint8Array(plaintext.length + pad);
  padded.set(plaintext);
  padded.fill(pad, plaintext.length);
  const out = new Uint8Array(padded.length);
  for (let i = 0; i < padded.length; i += 16) out.set(encryptBlock(padded.subarray(i, i + 16), w), i);
  return out;
}

/** Throws when the length or the padding is wrong — what a wrong key usually produces. */
export function aesEcbDecrypt(key: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  if (ciphertext.length === 0 || ciphertext.length % 16) throw new Error('bad decrypt: not whole blocks');
  const w = expandKey(key);
  const out = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i += 16) out.set(decryptBlock(ciphertext.subarray(i, i + 16), w), i);
  const pad = out[out.length - 1]!;
  if (pad < 1 || pad > 16) throw new Error('bad decrypt: padding');
  for (let i = out.length - pad; i < out.length; i++) if (out[i] !== pad) throw new Error('bad decrypt: padding');
  return out.subarray(0, out.length - pad);
}

// --- GCM ------------------------------------------------------------------------

const toBigInt = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
};

const fromBigInt = (value: bigint): Uint8Array => {
  const out = new Uint8Array(16);
  for (let i = 15; i >= 0; i--) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
};

const R = 0xe1n << 120n;

/** Multiplication in GF(2^128), in GCM's bit order. */
function gfMul(x: bigint, y: bigint): bigint {
  let z = 0n;
  let v = y;
  for (let i = 127; i >= 0; i--) {
    if ((x >> BigInt(i)) & 1n) z ^= v;
    v = v & 1n ? (v >> 1n) ^ R : v >> 1n;
  }
  return z;
}

function ghash(h: bigint, aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  let y = 0n;
  const absorb = (data: Uint8Array) => {
    for (let i = 0; i < data.length; i += 16) {
      const block = new Uint8Array(16);
      block.set(data.subarray(i, i + 16));
      y = gfMul(y ^ toBigInt(block), h);
    }
  };
  absorb(aad);
  absorb(ciphertext);
  const lengths = (BigInt(aad.length * 8) << 64n) | BigInt(ciphertext.length * 8);
  y = gfMul(y ^ lengths, h);
  return fromBigInt(y);
}

/** The counter block after `block`, incrementing its last 32 bits. */
function increment(block: Uint8Array): Uint8Array {
  const next = block.slice();
  for (let i = 15; i >= 12; i--) {
    next[i] = (next[i]! + 1) & 0xff;
    if (next[i] !== 0) break;
  }
  return next;
}

function gctr(w: Uint8Array, start: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let counter = start;
  for (let i = 0; i < data.length; i += 16) {
    const stream = encryptBlock(counter, w);
    for (let j = 0; j < 16 && i + j < data.length; j++) out[i + j] = data[i + j]! ^ stream[j]!;
    counter = increment(counter);
  }
  return out;
}

function gcmSetup(key: Uint8Array, iv: Uint8Array) {
  if (iv.length !== 12) throw new Error(`GCM here takes a 12-byte IV, not ${iv.length}`);
  const w = expandKey(key);
  const h = toBigInt(encryptBlock(new Uint8Array(16), w));
  const j0 = concat(iv, Uint8Array.of(0, 0, 0, 1));
  return { w, h, j0 };
}

export function aesGcmEncrypt(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array
): { ciphertext: Uint8Array; tag: Uint8Array } {
  const { w, h, j0 } = gcmSetup(key, iv);
  const ciphertext = gctr(w, increment(j0), plaintext);
  const tag = gctr(w, j0, ghash(h, aad, ciphertext));
  return { ciphertext, tag };
}

/** Throws when the tag does not match: the data was altered, or the key is wrong. */
export function aesGcmDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array, tag: Uint8Array): Uint8Array {
  const { w, h, j0 } = gcmSetup(key, iv);
  const expected = gctr(w, j0, ghash(h, aad, ciphertext));
  if (!equal(expected.subarray(0, tag.length), tag) || tag.length !== 16) {
    throw new Error('Unsupported state or unable to authenticate data');
  }
  return gctr(w, increment(j0), ciphertext);
}
