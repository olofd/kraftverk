import { ascii, concat, readU32, u32 } from './bytes.ts';
import { aesEcbDecrypt, aesEcbEncrypt, aesGcmDecrypt, aesGcmEncrypt } from './crypto/aes.ts';
import { crc32, hmacSha256 } from './crypto/hash.ts';

/**
 * Tuya LAN framing.
 *
 * Two wire formats exist. 3.1 through 3.4 use a `55AA` frame with a CRC32 (or,
 * on 3.4, an HMAC-SHA256); 3.5 replaces it with `6699` and AES-GCM. The layout
 * is documented in tinytuya's PROTOCOL.md, and this follows tinytuya's own
 * implementation of it (docs/ATORCH-S1W.md §1):
 *
 *   55AA  prefix(4) sequence(4) command(4) length(4) payload(n) crc32(4)  AA55
 *   55AA  prefix(4) sequence(4) command(4) length(4) payload(n) hmac(32)  AA55        (3.4)
 *   6699  prefix(4) zero(2) sequence(4) command(4) length(4) iv(12) payload(n) tag(16)  9966  (3.5)
 *
 * On 3.5 the length counts the IV, the payload and the tag, and the GCM
 * additional data is the header after the prefix. On 3.3 the version header
 * (`3.3` and twelve zeros) goes in front of the encrypted payload; on 3.4 and
 * 3.5 it goes inside the encryption — in both cases only on commands that carry
 * one (not queries, heartbeats or the session handshake).
 */

export const PREFIX_55AA = 0x000055aa;
export const SUFFIX_55AA = 0x0000aa55;
export const PREFIX_6699 = 0x00006699;
export const SUFFIX_6699 = 0x00009966;

export const CMD = {
  SESS_KEY_NEG_START: 0x03,
  SESS_KEY_NEG_RESP: 0x04,
  SESS_KEY_NEG_FINISH: 0x05,
  CONTROL: 0x07,
  STATUS: 0x08,
  HEART_BEAT: 0x09,
  DP_QUERY: 0x0a,
  CONTROL_NEW: 0x0d,
  DP_QUERY_NEW: 0x10,
  UPDATEDPS: 0x12,
  LAN_EXT_STREAM: 0x40,
} as const;

export type ProtocolVersion = '3.1' | '3.3' | '3.4' | '3.5';

export type TuyaFrame = {
  sequence: number;
  command: number;
  /** Decrypted, header stripped. Usually JSON, sometimes empty. */
  payload: Uint8Array;
  /** Non-zero when the device is complaining rather than answering. */
  returnCode: number;
};

/**
 * Payloads on 3.3 carry a 15-byte version header on everything except the
 * status query, and it must be stripped before decrypting a response that has
 * one. `3.3` followed by twelve zero bytes.
 */
const VERSION_HEADER_LENGTH = 15;

const versionHeader = (version: ProtocolVersion): Uint8Array => {
  const header = new Uint8Array(VERSION_HEADER_LENGTH);
  for (let i = 0; i < version.length; i++) header[i] = version.charCodeAt(i);
  return header;
};

const startsWithVersion = (payload: Uint8Array): boolean =>
  payload.length > VERSION_HEADER_LENGTH && /^3\.\d$/.test(ascii(payload.subarray(0, 3)));

/** Commands that go out without the 15-byte version header, on every version that has one. */
const NO_HEADER = new Set<number>([
  CMD.DP_QUERY,
  CMD.DP_QUERY_NEW,
  CMD.UPDATEDPS,
  CMD.HEART_BEAT,
  CMD.SESS_KEY_NEG_START,
  CMD.SESS_KEY_NEG_RESP,
  CMD.SESS_KEY_NEG_FINISH,
  CMD.LAN_EXT_STREAM,
]);

/** The payload with the version header in front, when this command carries one. */
const withHeader = (version: ProtocolVersion, command: number, payload: Uint8Array): Uint8Array =>
  NO_HEADER.has(command) ? payload : concat(versionHeader(version), payload);

export type EncodeOptions = {
  version: ProtocolVersion;
  /** Local key for 3.3, negotiated session key for 3.4/3.5. */
  key: Uint8Array;
  sequence: number;
  command: number;
  payload: Uint8Array;
  /** 3.5 only: the 12-byte IV. Random per frame. */
  iv?: Uint8Array;
};

export function encodeFrame(options: EncodeOptions): Uint8Array {
  const { version, key, sequence, command, payload } = options;

  if (version === '3.5') {
    const iv = options.iv ?? new Uint8Array(12);
    const plaintext = withHeader(version, command, payload);
    // IV, payload and tag. The header after the prefix is authenticated but not encrypted.
    const header = concat(u32(PREFIX_6699), Uint8Array.of(0, 0), u32(sequence), u32(command), u32(12 + plaintext.length + 16));
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, plaintext, header.subarray(4));
    return concat(header, iv, ciphertext, tag, u32(SUFFIX_6699));
  }

  let body: Uint8Array;
  if (version === '3.4') {
    body = aesEcbEncrypt(key, withHeader(version, command, payload));
  } else {
    body = aesEcbEncrypt(key, payload);
    if (version === '3.3') body = withHeader(version, command, body);
  }

  const integrityLength = version === '3.4' ? 32 : 4;
  const header = concat(u32(PREFIX_55AA), u32(sequence), u32(command), u32(body.length + integrityLength + 4));
  const withoutIntegrity = concat(header, body);
  const integrity = version === '3.4' ? hmacSha256(key, withoutIntegrity) : u32(crc32(withoutIntegrity));
  return concat(withoutIntegrity, integrity, u32(SUFFIX_55AA));
}

/**
 * Pulls whole frames out of a TCP stream.
 *
 * Devices coalesce and split responses freely, so the caller feeds bytes in and
 * takes frames out — the same shape as any assembler over a stream that
 * does not keep message boundaries.
 */
export class FrameReader {
  #buffer: Uint8Array = new Uint8Array();

  constructor(
    private version: ProtocolVersion,
    private key: Uint8Array
  ) {}

  /** Swaps in the session key once 3.4/3.5 negotiation completes. */
  useKey(key: Uint8Array): void {
    this.key = key;
  }

  reset(): void {
    this.#buffer = new Uint8Array();
  }

  push(chunk: Uint8Array): TuyaFrame[] {
    this.#buffer = concat(this.#buffer, chunk);
    const frames: TuyaFrame[] = [];

    for (;;) {
      const start = this.#findPrefix();
      if (start < 0) {
        // No frame starts in it: only its last bytes are kept, which may be the start of one still coming.
        this.#buffer = this.#buffer.subarray(this.#buffer.length - 3);
        break;
      }
      if (start > 0) this.#buffer = this.#buffer.subarray(start);
      if (this.#buffer.length < 20) break;

      const prefix = readU32(this.#buffer, 0);
      const total = prefix === PREFIX_6699 ? 18 + readU32(this.#buffer, 14) + 4 : 16 + readU32(this.#buffer, 12);

      if (!Number.isFinite(total) || total <= 0 || total > 65_536) {
        // Nonsense length: step over this prefix rather than wait for bytes
        // that will never come.
        this.#buffer = this.#buffer.subarray(4);
        continue;
      }
      if (this.#buffer.length < total) break;

      const raw = this.#buffer.subarray(0, total);
      this.#buffer = this.#buffer.subarray(total);

      const frame = this.#decode(raw);
      if (frame) frames.push(frame);
    }

    return frames;
  }

  #findPrefix(): number {
    for (let i = 0; i + 4 <= this.#buffer.length; i++) {
      const value = readU32(this.#buffer, i);
      if (value === PREFIX_55AA || value === PREFIX_6699) return i;
    }
    return this.#buffer.length >= 4 ? -1 : 0;
  }

  #decode(raw: Uint8Array): TuyaFrame | null {
    if (readU32(raw, 0) === PREFIX_6699) return this.#decode6699(raw);

    const sequence = readU32(raw, 4);
    const command = readU32(raw, 8);
    const declared = readU32(raw, 12);
    const integrityLength = this.version === '3.4' ? 32 : 4;

    const bodyEnd = 16 + declared - integrityLength - 4;
    if (bodyEnd < 16 || bodyEnd > raw.length) return null;

    let body = raw.subarray(16, bodyEnd);

    // A four-byte return code precedes the payload on a response.
    let returnCode = 0;
    if (body.length >= 4 && readU32(body, 0) < 0x100) {
      returnCode = readU32(body, 0);
      body = body.subarray(4);
    }

    if (startsWithVersion(body)) body = body.subarray(VERSION_HEADER_LENGTH);
    if (body.length === 0) return { sequence, command, payload: body, returnCode };

    let payload: Uint8Array;
    try {
      payload = aesEcbDecrypt(this.key, body);
    } catch {
      // Some devices answer errors in the clear.
      payload = body;
    }

    // 3.4 carries its version header inside the encryption.
    if (startsWithVersion(payload)) payload = payload.subarray(VERSION_HEADER_LENGTH);
    return { sequence, command, payload, returnCode };
  }

  #decode6699(raw: Uint8Array): TuyaFrame | null {
    const sequence = readU32(raw, 6);
    const command = readU32(raw, 10);
    const length = readU32(raw, 14);
    if (length < 28 || 18 + length > raw.length) return null;
    const iv = raw.subarray(18, 30);
    const ciphertext = raw.subarray(30, 18 + length - 16);
    const tag = raw.subarray(18 + length - 16, 18 + length);

    let payload: Uint8Array;
    try {
      payload = aesGcmDecrypt(this.key, iv, ciphertext, raw.subarray(4, 18), tag);
    } catch {
      return null;
    }
    // A response carries a return code, then the version header, inside the encryption.
    let returnCode = 0;
    if (payload.length >= 4 && readU32(payload, 0) < 0x100) {
      returnCode = readU32(payload, 0);
      payload = payload.subarray(4);
    }
    if (startsWithVersion(payload)) payload = payload.subarray(VERSION_HEADER_LENGTH);
    return { sequence, command, payload, returnCode };
  }
}
