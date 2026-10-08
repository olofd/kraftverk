import { pbkdf2Sha256, sha256 } from '@kraftverk/device-sdk';

/*
  SRP-6a as Apple's sign-in speaks it (idmsa.apple.com, since 2024): the
  2048-bit group of RFC 5054, SHA-256, and no username in x — as pysrp
  computes it with rfc5054_enable() and no_username_in_x(), which pyicloud
  uses — and padded as Apple's own web client pads (its
  webSRPClientWorker.js): A, g and S to the prime's width, B as Apple sent
  it, the account name lowercased where it is hashed. Unpadded, about one
  sign-in in a hundred — an A or S that happens to begin with a zero byte —
  is refused as a wrong password. The password itself never leaves: it is
  stretched with PBKDF2 into the secret x is made from, and only a proof of
  knowing it (M1) is sent.

  Ported from pyicloud and pysrp (MIT; NOTICE).
*/

/** The group's prime: RFC 5054, Appendix A, 2048 bits. */
const N = BigInt(
  '0x' +
    'AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050A37329CBB4' +
    'A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50E8083969EDB767B0CF60' +
    '95179A163AB3661A05FBD5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF' +
    '747359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A436C6481F1D2B907' +
    '8717461A5B9D32E688F87748544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB37861' +
    '60279004E57AE6AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DB' +
    'FBB694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73'
);
const g = 2n;
/** How wide the prime is, in bytes: what RFC 5054 pads to. */
const WIDTH = 256;

/** How Apple asks the password to be stretched: from its SHA-256 digest (s2k), or from that digest in hex (s2k_fo). */
export type SrpProtocol = 's2k' | 's2k_fo';

const encoder = new TextEncoder();

/** A number as its bytes, big-endian, with no leading zeros — pysrp's long_to_bytes. */
export function bytesOfBig(value: bigint): Uint8Array {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return new Uint8Array((hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));
}

/** Bytes as a number, big-endian. */
export function bigOfBytes(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Bytes, zero-padded on the left to the prime's width. */
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

/** base^exponent mod m, by squaring. */
export function modPow(base: bigint, exponent: bigint, m: bigint): bigint {
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

/** The secret the password is stretched into: PBKDF2-SHA256 of its SHA-256 digest — or of that digest in hex, for s2k_fo. */
export function passwordKey(password: string, salt: Uint8Array, iterations: number, protocol: SrpProtocol): Uint8Array {
  const digest = sha256(password);
  const input = protocol === 's2k_fo' ? encoder.encode([...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')) : digest;
  return pbkdf2Sha256(input, salt, iterations, 32);
}

/** k = H(N | PAD(g)). */
const k = bigOfBytes(sha256(join(bytesOfBig(N), padded(bytesOfBig(g)))));

/** H(N) xor H(PAD(g)): what M begins with. */
const hNxorg = (() => {
  const hN = sha256(bytesOfBig(N));
  const hg = sha256(padded(bytesOfBig(g)));
  return hN.map((byte, index) => byte ^ hg[index]!);
})();

/** A client's side of one sign-in: its secret a, and A to send — padded to the prime's width, as Apple's own client sends it. */
export type SrpClient = { a: bigint; A: Uint8Array };

/** Starts a sign-in: a random secret a, and A = g^a mod N. */
export function srpStart(random: Uint8Array = crypto.getRandomValues(new Uint8Array(32))): SrpClient {
  const a = bigOfBytes(random);
  return { a, A: padded(bytesOfBig(modPow(g, a, N))) };
}

/** What the account name is hashed as: lowercased, as Apple's client hashes it. */
const nameHash = (accountName: string) => sha256(accountName.toLowerCase());

/**
 * The proofs for the server's challenge: M1, that this side knows the
 * password, and M2, what the server's own proof must be — with K, the key
 * both sides now share, which Apple's escrow step asks for. Null when the
 * challenge is one no honest server sends (B ≡ 0, u = 0).
 */
export function srpProofs(input: { client: SrpClient; accountName: string; key: Uint8Array; salt: Uint8Array; B: Uint8Array }): { m1: Uint8Array; m2: Uint8Array; K: Uint8Array } | null {
  const { client, accountName, key, salt } = input;
  const B = bigOfBytes(input.B);
  if (B % N === 0n) return null;
  const A = padded(client.A);
  const u = bigOfBytes(sha256(join(A, padded(bytesOfBig(B)))));
  if (u === 0n) return null;
  // No username in x: H(salt | H(":" | key)).
  const x = bigOfBytes(sha256(join(salt, sha256(join(encoder.encode(':'), key)))));
  const v = modPow(g, x, N);
  const S = modPow(B - k * v, client.a + u * x, N);
  const K = sha256(padded(bytesOfBig(S)));
  // B as Apple sent it, not as a number re-made: a leading zero it sent is part of what it hashes.
  const m1 = sha256(join(hNxorg, nameHash(accountName), salt, A, input.B, K));
  const m2 = sha256(join(A, m1, K));
  return { m1, m2, K };
}

/** What a server keeps of a password, and how it answers — for tests to play Apple with. */
export const srpServer = {
  /** The verifier v = g^x mod N, from the stretched key and salt. */
  verifier(key: Uint8Array, salt: Uint8Array): bigint {
    return modPow(g, bigOfBytes(sha256(join(salt, sha256(join(encoder.encode(':'), key))))), N);
  },
  /** B = k·v + g^b mod N, padded as Apple sends it. */
  challenge(verifier: bigint, b: bigint): Uint8Array {
    return padded(bytesOfBig((k * verifier + modPow(g, b, N)) % N));
  },
  /** The proof a client that knows the password sends, as the server computes it — and the key both then share. */
  expected(input: { verifier: bigint; b: bigint; A: Uint8Array; B: Uint8Array; accountName: string; salt: Uint8Array }): { m1: Uint8Array; K: Uint8Array } {
    const A = padded(input.A);
    const u = bigOfBytes(sha256(join(A, padded(input.B))));
    const S = modPow(bigOfBytes(A) * modPow(input.verifier, u, N), input.b, N);
    const K = sha256(padded(bytesOfBig(S)));
    return { m1: sha256(join(hNxorg, nameHash(input.accountName), input.salt, A, input.B, K)), K };
  },
};
