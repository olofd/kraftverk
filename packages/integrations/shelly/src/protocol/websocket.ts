import type { ByteChannel } from '@kraftverk/device-sdk';

/*
  A WebSocket client (RFC 6455) over a byte channel: the handshake, then
  text frames both ways — the client's masked, as the RFC requires — with
  pings answered and messages split across frames put back together. Pure:
  the channel is the home network's TCP connection, opened by the
  transport. A connection that drops and comes back is opened again,
  handshake and all; what was sent before is gone with it.
*/

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** The most a message from the device may be: a status is a few kilobytes. */
const MESSAGE_MAX = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Four random bytes, the key a client masks a frame with: never the same twice. */
const maskKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(4));

const base64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** One frame from the client: final, masked, its length in as few bytes as fit. */
export function clientFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const length = payload.length;
  const lengthBytes = length < 126 ? [0x80 | length] : length < 0x10000 ? [0x80 | 126, length >> 8, length & 0xff] : [0x80 | 127, 0, 0, 0, 0, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
  const mask = maskKey();
  const frame = new Uint8Array(1 + lengthBytes.length + 4 + length);
  frame[0] = 0x80 | opcode;
  frame.set(lengthBytes, 1);
  frame.set(mask, 1 + lengthBytes.length);
  const start = 1 + lengthBytes.length + 4;
  for (let index = 0; index < length; index++) frame[start + index] = payload[index]! ^ mask[index % 4]!;
  return frame;
}

/** One frame as read: whether it ends its message, what it is, and what it carries — unmasked, whoever sent it. */
type Frame = { final: boolean; opcode: number; payload: Uint8Array };

/** Reads every whole frame at the start of `data`: the frames, and how many bytes they took. */
export function readFrames(data: Uint8Array): { frames: Frame[]; used: number } {
  const frames: Frame[] = [];
  let at = 0;
  while (data.length - at >= 2) {
    const first = data[at]!;
    const second = data[at + 1]!;
    let length = second & 0x7f;
    let header = 2;
    if (length === 126) {
      if (data.length - at < 4) break;
      length = (data[at + 2]! << 8) | data[at + 3]!;
      header = 4;
    } else if (length === 127) {
      if (data.length - at < 10) break;
      // A message past 4 GB is no device's: the high bytes are read as nothing more.
      length = ((data[at + 6]! << 24) >>> 0) + (data[at + 7]! << 16) + (data[at + 8]! << 8) + data[at + 9]!;
      header = 10;
    }
    if (length > MESSAGE_MAX) throw new Error('A WebSocket frame too long to be the device’s');
    const masked = (second & 0x80) !== 0;
    const total = header + (masked ? 4 : 0) + length;
    if (data.length - at < total) break;
    let payload = data.slice(at + header + (masked ? 4 : 0), at + total);
    if (masked) {
      const mask = data.subarray(at + header, at + header + 4);
      payload = payload.map((byte, index) => byte ^ mask[index % 4]!);
    }
    frames.push({ final: (first & 0x80) !== 0, opcode: first & 0x0f, payload });
    at += total;
  }
  return { frames, used: at };
}

const joined = (parts: readonly Uint8Array[]): Uint8Array => {
  const all = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
};

export type WebSocketOptions = {
  /** The path the WebSocket is at: `/rpc`. */
  path: string;
  /** What the request says it is for: the device's address. */
  host: string;
  /** Each text message, as it comes. */
  onMessage(text: string): void;
  /** Open — handshake done — or not. */
  onOpen?(open: boolean): void;
};

/** A WebSocket over a byte channel: open while the channel is connected and the handshake held. */
export class WebSocketOver {
  #buffer: Uint8Array = new Uint8Array(0);
  #open = false;
  #handshaking = false;
  #fragments: Uint8Array[] = [];
  #stops: (() => void)[] = [];
  #waiting = new Set<() => void>();

  constructor(
    private channel: ByteChannel,
    private options: WebSocketOptions
  ) {
    this.#stops.push(channel.onData((bytes) => this.#heard(bytes)));
    this.#stops.push(
      channel.onConnectedChange((connected) => {
        if (connected) void this.#handshake();
        else this.#closed();
      })
    );
    if (channel.connected) void this.#handshake();
  }

  get open(): boolean {
    return this.#open;
  }

  /** Waits until it is open, at most `ms`: false when it did not open in time. */
  opened(ms: number): Promise<boolean> {
    if (this.#open) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (open: boolean) => {
        clearTimeout(timer);
        this.#waiting.delete(ready);
        resolve(open);
      };
      const ready = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      this.#waiting.add(ready);
    });
  }

  /** Sends one text message. Throws when it is not open. */
  async send(text: string): Promise<void> {
    if (!this.#open) throw new Error('Not connected to the device');
    await this.channel.write(clientFrame(OPCODE.text, encoder.encode(text)));
  }

  async close(): Promise<void> {
    for (const stop of this.#stops) stop();
    if (this.#open) await this.channel.write(clientFrame(OPCODE.close, new Uint8Array(0))).catch(() => undefined);
    this.#closed();
  }

  async #handshake(): Promise<void> {
    if (this.#handshaking || this.#open) return;
    this.#handshaking = true;
    this.#buffer = new Uint8Array(0);
    const key = base64(crypto.getRandomValues(new Uint8Array(16)));
    const request = [`GET ${this.options.path} HTTP/1.1`, `Host: ${this.options.host}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n');
    try {
      await this.channel.write(encoder.encode(request));
    } catch {
      this.#handshaking = false;
    }
  }

  #closed(): void {
    const was = this.#open;
    this.#open = false;
    this.#handshaking = false;
    this.#fragments = [];
    this.#buffer = new Uint8Array(0);
    if (was) this.options.onOpen?.(false);
  }

  #heard(bytes: Uint8Array): void {
    this.#buffer = joined([this.#buffer, bytes]);
    if (this.#handshaking) {
      // The answer to the handshake: its headers end at the first blank line; what follows is frames already.
      const text = decoder.decode(this.#buffer);
      const end = text.indexOf('\r\n\r\n');
      if (end < 0) return;
      const status = /^HTTP\/1\.1 (\d{3})/.exec(text)?.[1];
      this.#handshaking = false;
      if (status !== '101') {
        // Not a WebSocket here: the connection is dropped, and tried again with a fresh one.
        void this.channel.reset?.();
        return;
      }
      this.#buffer = this.#buffer.subarray(encoder.encode(text.slice(0, end + 4)).length);
      this.#open = true;
      this.options.onOpen?.(true);
      for (const ready of [...this.#waiting]) ready();
    }
    if (!this.#open) return;
    let read: ReturnType<typeof readFrames>;
    try {
      read = readFrames(this.#buffer);
    } catch {
      void this.channel.reset?.();
      return;
    }
    this.#buffer = this.#buffer.subarray(read.used);
    for (const frame of read.frames) this.#frame(frame);
  }

  #frame(frame: Frame): void {
    switch (frame.opcode) {
      case OPCODE.ping:
        void this.channel.write(clientFrame(OPCODE.pong, frame.payload)).catch(() => undefined);
        return;
      case OPCODE.pong:
        return;
      case OPCODE.close:
        // The device ends it: so does this side, and the channel makes a fresh connection.
        this.#closed();
        void this.channel.reset?.();
        return;
      case OPCODE.text:
      case OPCODE.binary:
        this.#fragments = [frame.payload];
        break;
      case OPCODE.continuation:
        this.#fragments.push(frame.payload);
        break;
      default:
        return;
    }
    if (!frame.final) return;
    const message = decoder.decode(joined(this.#fragments));
    this.#fragments = [];
    this.options.onMessage(message);
  }
}
