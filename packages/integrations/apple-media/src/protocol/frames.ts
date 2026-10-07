/*
  The Companion protocol's frames, as pyatv reads them (MIT; NOTICE): a
  type byte, three bytes of length, big-endian, and the payload. Once a
  connection is verified, every payload is sealed with ChaCha20-Poly1305 —
  the four header bytes its additional data, a counter its nonce, each
  direction its own key and count.
*/

import { open, seal } from './crypto.ts';
import type { SessionKeys } from './pairing.ts';

/** The frame types Companion uses. */
export const FrameType = {
  NoOp: 0x01,
  PairSetupStart: 0x03,
  PairSetupNext: 0x04,
  PairVerifyStart: 0x05,
  PairVerifyNext: 0x06,
  /** OPACK, plain: before a connection is verified. */
  PlainOpack: 0x07,
  /** OPACK, sealed: everything after. */
  SealedOpack: 0x08,
  PackedOpack: 0x09,
} as const;

export type Frame = { type: number; payload: Uint8Array };

const HEADER = 4;
const TAG = 16;

/** A counter as a 12-byte little-endian nonce. */
const counterNonce = (count: number): Uint8Array => {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setUint32(0, count >>> 0, true);
  new DataView(nonce.buffer).setUint32(4, Math.floor(count / 2 ** 32), true);
  return nonce;
};

const header = (type: number, length: number): Uint8Array => new Uint8Array([type, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);

/**
 * Frames in and out of one connection: what arrives split or joined is
 * gathered into whole frames, and once keys are set every payload is
 * sealed and opened.
 */
export class Framer {
  #pending: Uint8Array = new Uint8Array(0);
  #keys: SessionKeys | null = null;
  #sent = 0;
  #read = 0;

  /** From now on, every payload sealed — after pair-verify. */
  encrypt(keys: SessionKeys): void {
    this.#keys = keys;
    this.#sent = 0;
    this.#read = 0;
  }

  get encrypted(): boolean {
    return this.#keys !== null;
  }

  /** A frame as bytes to write. */
  write(type: number, payload: Uint8Array): Uint8Array {
    if (!this.#keys || payload.length === 0) return join(header(type, payload.length), payload);
    const head = header(type, payload.length + TAG);
    const sealed = seal(this.#keys.output, counterNonce(this.#sent++), payload, head);
    return join(head, sealed);
  }

  /** Bytes as they arrived, and the whole frames they complete. */
  read(bytes: Uint8Array): Frame[] {
    this.#pending = join(this.#pending, bytes);
    const frames: Frame[] = [];
    while (this.#pending.length >= HEADER) {
      const length = (this.#pending[1]! << 16) | (this.#pending[2]! << 8) | this.#pending[3]!;
      if (this.#pending.length < HEADER + length) break;
      const head = this.#pending.slice(0, HEADER);
      let payload: Uint8Array = this.#pending.slice(HEADER, HEADER + length);
      this.#pending = this.#pending.slice(HEADER + length);
      if (this.#keys && payload.length > 0) {
        const opened = open(this.#keys.input, counterNonce(this.#read++), payload, head);
        if (!opened) throw new Error('A frame from the TV could not be opened: the connection is out of step');
        payload = opened;
      }
      frames.push({ type: head[0]!, payload });
    }
    return frames;
  }
}

function join(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
