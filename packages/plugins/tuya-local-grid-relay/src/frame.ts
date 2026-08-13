import {
  aesEcbDecrypt,
  aesEcbEncrypt,
  aesGcmDecrypt,
  aesGcmEncrypt,
  crc32,
  hmacSha256,
} from './crypto.ts';

/**
 * Tuya LAN framing.
 *
 * Two wire formats exist. 3.1 through 3.4 use a `55AA` frame with a CRC32 (or,
 * on 3.4, an HMAC-SHA256); 3.5 replaces it with `6699` and AES-GCM. The layout
 * is documented in tinytuya's PROTOCOL.md and implemented here directly.
 *
 *   55AA  prefix(4) sequence(4) command(4) length(4) payload(n) crc32(4)  AA55
 *   55AA  prefix(4) sequence(4) command(4) length(4) payload(n) hmac(32)  AA55   (3.4)
 *   6699  prefix(4) unknown(2)  iv(12) [command(4) length(4) payload(n)]  tag(16) 9966  (3.5)
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
} as const;

export type ProtocolVersion = '3.1' | '3.3' | '3.4' | '3.5';

export type TuyaFrame = {
  sequence: number;
  command: number;
  /** Decrypted, header stripped. Usually JSON, sometimes empty. */
  payload: Buffer;
  /** Non-zero when the device is complaining rather than answering. */
  returnCode: number;
};

/**
 * Payloads on 3.3 carry a 15-byte version header on everything except the
 * status query, and it must be stripped before decrypting a response that has
 * one. `3.3` followed by twelve zero bytes.
 */
const VERSION_HEADER_LENGTH = 15;

const versionHeader = (version: ProtocolVersion): Buffer => {
  const header = Buffer.alloc(VERSION_HEADER_LENGTH);
  header.write(version, 0, 'ascii');
  return header;
};

const startsWithVersion = (payload: Buffer): boolean =>
  payload.length > VERSION_HEADER_LENGTH && /^3\.\d$/.test(payload.subarray(0, 3).toString('ascii'));

/** Commands that go out without the 15-byte version header on 3.3. */
const NO_HEADER = new Set<number>([CMD.DP_QUERY, CMD.DP_QUERY_NEW, CMD.HEART_BEAT]);

export type EncodeOptions = {
  version: ProtocolVersion;
  /** Local key for 3.3, negotiated session key for 3.4/3.5. */
  key: Buffer;
  sequence: number;
  command: number;
  payload: Buffer;
  /** 3.5 only: the 12-byte IV. Random per frame. */
  iv?: Buffer;
};

export function encodeFrame(options: EncodeOptions): Buffer {
  const { version, key, sequence, command, payload } = options;

  if (version === '3.5') {
    const iv = options.iv ?? Buffer.alloc(12);
    // The header is authenticated but not encrypted, and covers command+length.
    const inner = Buffer.alloc(8);
    inner.writeUInt32BE(command, 0);
    inner.writeUInt32BE(payload.length + 16, 4);

    const aad = Buffer.concat([Buffer.from([0x00, 0x00, 0x66, 0x99, 0x00, 0x00]), iv, inner]);
    const { ciphertext, tag } = aesGcmEncrypt(key, iv, payload, aad);

    return Buffer.concat([aad, ciphertext, tag, uint32(SUFFIX_6699)]);
  }

  let body = aesEcbEncrypt(key, payload);
  if (version === '3.3' && !NO_HEADER.has(command)) {
    body = Buffer.concat([versionHeader(version), body]);
  }

  const integrityLength = version === '3.4' ? 32 : 4;
  const header = Buffer.alloc(16);
  header.writeUInt32BE(PREFIX_55AA, 0);
  header.writeUInt32BE(sequence, 4);
  header.writeUInt32BE(command, 8);
  header.writeUInt32BE(body.length + integrityLength + 4, 12);

  const withoutIntegrity = Buffer.concat([header, body]);
  const integrity =
    version === '3.4'
      ? hmacSha256(key, withoutIntegrity)
      : uint32(crc32(withoutIntegrity));

  return Buffer.concat([withoutIntegrity, integrity, uint32(SUFFIX_55AA)]);
}

const uint32 = (value: number): Buffer => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
};

/**
 * Pulls whole frames out of a TCP stream.
 *
 * Devices coalesce and split responses freely, so the caller feeds bytes in and
 * takes frames out — the same shape as the station's BLE assembler, for the
 * same reason.
 */
export class FrameReader {
  #buffer = Buffer.alloc(0);

  constructor(
    private version: ProtocolVersion,
    private key: Buffer
  ) {}

  /** Swaps in the session key once 3.4/3.5 negotiation completes. */
  useKey(key: Buffer): void {
    this.key = key;
  }

  reset(): void {
    this.#buffer = Buffer.alloc(0);
  }

  push(chunk: Buffer): TuyaFrame[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames: TuyaFrame[] = [];

    for (;;) {
      const start = this.#findPrefix();
      if (start < 0) break;
      if (start > 0) this.#buffer = this.#buffer.subarray(start);
      if (this.#buffer.length < 20) break;

      const prefix = this.#buffer.readUInt32BE(0);
      const total =
        prefix === PREFIX_6699
          ? 4 + 2 + 12 + this.#buffer.readUInt32BE(18) + 4
          : 16 + this.#buffer.readUInt32BE(12);

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
      const value = this.#buffer.readUInt32BE(i);
      if (value === PREFIX_55AA || value === PREFIX_6699) return i;
    }
    return this.#buffer.length >= 4 ? -1 : 0;
  }

  #decode(raw: Buffer): TuyaFrame | null {
    if (raw.readUInt32BE(0) === PREFIX_6699) return this.#decode6699(raw);

    const sequence = raw.readUInt32BE(4);
    const command = raw.readUInt32BE(8);
    const declared = raw.readUInt32BE(12);
    const integrityLength = this.version === '3.4' ? 32 : 4;

    const bodyEnd = 16 + declared - integrityLength - 4;
    if (bodyEnd < 16 || bodyEnd > raw.length) return null;

    let body = raw.subarray(16, bodyEnd);

    // A four-byte return code precedes the payload on a response.
    let returnCode = 0;
    if (body.length >= 4 && body.readUInt32BE(0) < 0x100) {
      returnCode = body.readUInt32BE(0);
      body = body.subarray(4);
    }

    if (startsWithVersion(body)) body = body.subarray(VERSION_HEADER_LENGTH);
    if (body.length === 0) return { sequence, command, payload: body, returnCode };

    let payload: Buffer;
    try {
      payload = aesEcbDecrypt(this.key, body);
    } catch {
      // Some devices answer errors in the clear.
      payload = body;
    }

    return { sequence, command, payload, returnCode };
  }

  #decode6699(raw: Buffer): TuyaFrame | null {
    const iv = raw.subarray(6, 18);
    const length = raw.readUInt32BE(22);
    const aad = raw.subarray(0, 26);
    const ciphertext = raw.subarray(26, 26 + length - 16);
    const tag = raw.subarray(26 + length - 16, 26 + length);

    try {
      const payload = aesGcmDecrypt(this.key, iv, ciphertext, aad, tag);
      return {
        sequence: raw.readUInt32BE(0) && 0,
        command: raw.readUInt32BE(18),
        payload,
        returnCode: 0,
      };
    } catch {
      return null;
    }
  }
}
