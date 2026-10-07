import { sha512Of } from './crypto.ts';

/*
  SRP-6a as HomeKit's pair-setup speaks it — and so the Apple TV's: the
  3072-bit group of RFC 5054 with g = 5, SHA-512, the username
  "Pair-Setup" and the PIN the TV shows as the password. Checked against
  HomeKit's published test vectors (fast-srp's, from HAP-NodeJS).

  Ported from pyatv (MIT) and srptools; NOTICE.
*/

/** The group's prime: RFC 5054, Appendix A, 3072 bits. */
const N = BigInt(
  '0x' +
    'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
    'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
    'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
    '83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
    'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
    '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
    'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
    'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF'
);
const g = 5n;
const WIDTH = 384;

/** A number as its bytes, big-endian, no leading zeros. */
export function bytesOfBig(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

export function bigOfBytes(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

const padded = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length >= WIDTH) return bytes;
  const out = new Uint8Array(WIDTH);
  out.set(bytes, WIDTH - bytes.length);
  return out;
};

const join = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

function modPow(base: bigint, exponent: bigint, m: bigint): bigint {
  let result = 1n;
  let b = ((base % m) + m) % m;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

/** k = H(N | PAD(g)). */
export const k = bigOfBytes(sha512Of(join(bytesOfBig(N), padded(bytesOfBig(g)))));

/** x = H(s | H(I ":" P)). */
export const xOf = (username: string, password: string, salt: Uint8Array): bigint => bigOfBytes(sha512Of(join(salt, sha512Of(`${username}:${password}`))));

/** v = g^x: what a server keeps of a password — for the tests to play a TV with. */
export const verifierOf = (username: string, password: string, salt: Uint8Array): bigint => modPow(g, xOf(username, password, salt), N);

/** A = g^a. */
export const publicOf = (a: bigint): Uint8Array => bytesOfBig(modPow(g, a, N));

/** B = k·v + g^b: a server's public value, for the tests. */
export const serverPublicOf = (verifier: bigint, b: bigint): Uint8Array => bytesOfBig((k * verifier + modPow(g, b, N)) % N);

/** H(N) xor H(g). */
const hNxorg = (() => {
  const hN = sha512Of(bytesOfBig(N));
  const hg = sha512Of(bytesOfBig(g));
  return hN.map((byte, index) => byte ^ hg[index]!);
})();

/** What one side of an exchange works out: u, the shared secret S, the session key K, and the two proofs. */
export type SrpOutcome = { u: bigint; S: bigint; K: Uint8Array; M1: Uint8Array; M2: Uint8Array };

/**
 * The client's side, once the server's salt and B are in: the session key
 * and the proof (M1) to send, and the proof (M2) the server must answer.
 * Null for a B no honest server sends.
 */
export function clientSide(input: { username: string; password: string; salt: Uint8Array; a: bigint; B: Uint8Array }): SrpOutcome | null {
  const B = bigOfBytes(input.B);
  if (B % N === 0n) return null;
  const A = modPow(g, input.a, N);
  const u = bigOfBytes(sha512Of(join(padded(bytesOfBig(A)), padded(bytesOfBig(B)))));
  if (u === 0n) return null;
  const x = xOf(input.username, input.password, input.salt);
  const S = modPow(B - k * modPow(g, x, N), input.a + u * x, N);
  const K = sha512Of(bytesOfBig(S));
  const M1 = sha512Of(join(hNxorg, sha512Of(input.username), input.salt, bytesOfBig(A), bytesOfBig(B), K));
  const M2 = sha512Of(join(bytesOfBig(A), M1, K));
  return { u, S, K, M1, M2 };
}

/** The server's side, for the tests to play a TV with: its session key and the proof it expects. */
export function serverSide(input: { username: string; verifier: bigint; salt: Uint8Array; b: bigint; A: Uint8Array }): { K: Uint8Array; M1: Uint8Array; M2: Uint8Array } {
  const A = bigOfBytes(input.A);
  const B = bigOfBytes(serverPublicOf(input.verifier, input.b));
  const u = bigOfBytes(sha512Of(join(padded(bytesOfBig(A)), padded(bytesOfBig(B)))));
  const S = modPow(A * modPow(input.verifier, u, N), input.b, N);
  const K = sha512Of(bytesOfBig(S));
  const M1 = sha512Of(join(hNxorg, sha512Of(input.username), input.salt, bytesOfBig(A), bytesOfBig(B), K));
  return { K, M1, M2: sha512Of(join(bytesOfBig(A), M1, K)) };
}

export const randomPrivate = (): bigint => bigOfBytes(crypto.getRandomValues(new Uint8Array(32)));
