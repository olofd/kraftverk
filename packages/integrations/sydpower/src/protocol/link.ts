import type { ByteChannel, Channel, MessageChannel } from '@kraftverk/device-sdk';

import { FrameAssembler, WRITE_SPACING_MS } from './ble.ts';
import { commandRefusal } from './guard.ts';
import { answers, parseCommand, parseFrame, type ParsedFrame } from './modbus.ts';
import { channelOf, TOPICS } from './mqtt.ts';

/**
 * One conversation with one station, over whichever channel it was given.
 *
 * Every transport carries byte-identical MODBUS frames — the Bluetooth
 * characteristic pair and the broker's topics speak the same protocol — so
 * everything above this is shared, on the server and in the app alike. What
 * differs is only how a frame is put on the channel and how an answer is told
 * apart from everything else arriving on it.
 *
 * And every frame passes the guard on its way out (`commandRefusal`), whoever
 * built it: the one rule no frame to a station may break is applied at the
 * last point this code controls.
 */
export interface SydpowerLink {
  /** The transport this link rides: `mqtt`, `ble`. */
  readonly transport: string;
  /** The station's address on that transport. */
  readonly address: string;
  /** True when the station is reachable right now. */
  readonly connected: boolean;
  send(frame: Uint8Array): Promise<void>;
  /**
   * Sends a frame and resolves with the matching response. `expect` selects the
   * answer: telemetry (0x04) or settings (0x03).
   *
   * The protocol has no correlation id, so answers pair by arrival and by kind:
   * a write's echo or an exception shares the channel with a settings read, and
   * must not be taken for its answer. Keep requests serialised.
   */
  request(frame: Uint8Array, expect: 'input' | 'holding', timeoutMs?: number): Promise<ParsedFrame>;
  /** Every frame the station sends, asked for or not. */
  onFrame(listener: (frame: ParsedFrame) => void): () => void;
  onConnectedChange(listener: (connected: boolean) => void): () => void;
  /**
   * Stops listening. The channel stays open: it belongs to whoever opened it,
   * which closes it when the session ends.
   */
  close(): Promise<void>;
}

/** Refuses what must never reach a station. */
const guarded = (frame: Uint8Array): void => {
  const refusal = commandRefusal(frame);
  if (refusal) throw new Error(refusal);
};

const functionFor = (expect: 'input' | 'holding') => (expect === 'input' ? 0x04 : 0x03);

/** The read a request makes: what its answer must be. A request that is not a read of the expected kind is not one this asks. */
function readOf(frame: Uint8Array, expect: 'input' | 'holding'): { fn: number; start: number; count: number } {
  const command = parseCommand(frame);
  const fn = functionFor(expect);
  if (command?.kind !== 'read' || command.fn !== fn) throw new Error(`A request is a read of ${expect} registers (function 0x0${fn})`);
  return { fn, start: command.start, count: command.count };
}

/** Frames, and a way to wait for one. */
function frames() {
  const listeners = new Set<(frame: ParsedFrame) => void>();
  return {
    add(listener: (frame: ParsedFrame) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(frame: ParsedFrame) {
      for (const listener of [...listeners]) listener(frame);
    },
    /** Resolves with the first frame `accept` takes, or rejects at the deadline. */
    wait(accept: (frame: ParsedFrame) => boolean, timeoutMs: number, what: string) {
      let stop = () => {};
      const promise = new Promise<ParsedFrame>((resolve, reject) => {
        const timer = setTimeout(() => {
          stop();
          reject(new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`));
        }, timeoutMs);
        const off = this.add((frame) => {
          if (!accept(frame)) return;
          stop();
          resolve(frame);
        });
        stop = () => {
          clearTimeout(timer);
          off();
        };
      });
      return { promise, cancel: () => stop() };
    },
  };
}

/**
 * Over a broker: frames are MQTT payloads on the station's own topics.
 *
 * Telemetry answers on `…/response/04`, everything else — write echoes
 * included — on `…/response/data`, so an answer is matched by its channel and
 * its function code.
 */
function overMessages(channel: MessageChannel, address: string): SydpowerLink {
  const mac = address.toUpperCase();
  const incoming = frames();
  const byChannel = new Map<string, ReturnType<typeof frames>>();
  const on = (name: string) => {
    let entry = byChannel.get(name);
    if (!entry) byChannel.set(name, (entry = frames()));
    return entry;
  };

  const unsubscribe = channel.subscribe(TOPICS.responses(mac), (message) => {
    const name = channelOf(message.topic);
    if (!name) return;
    const frame = parseFrame(message.payload);
    if (!frame) return; // malformed or a bad CRC: keep waiting
    on(name).emit(frame);
    incoming.emit(frame);
  });

  const send = async (frame: Uint8Array) => {
    guarded(frame);
    if (!channel.connected) throw new Error(`${mac} is not connected to the broker`);
    await channel.publish(TOPICS.command(mac), frame);
  };

  return {
    transport: 'mqtt',
    address: mac,
    get connected() {
      return channel.connected;
    },
    send,
    async request(frame, expect, timeoutMs = 5000) {
      const read = readOf(frame, expect);
      const name = expect === 'input' ? '04' : 'data';
      const answer = on(name).wait(
        (parsed) => answers(parsed, read),
        timeoutMs,
        `${mac}/${name}`
      );
      try {
        await send(frame);
      } catch (error) {
        answer.cancel();
        throw error;
      }
      return answer.promise;
    },
    onFrame: incoming.add,
    onConnectedChange: (listener) => channel.onConnectedChange(listener),
    async close() {
      unsubscribe();
    },
  };
}

/**
 * Over a byte stream: a Bluetooth characteristic pair.
 *
 * The characteristic splits a 168-byte response across several notifications,
 * so they are reassembled into frames first. And the station drops frames sent
 * too close together, so writes are spaced.
 */
function overBytes(channel: ByteChannel, address: string, transport: string): SydpowerLink {
  const incoming = frames();
  const assembler = new FrameAssembler();
  let lastWrite = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const stopData = channel.onData((bytes) => {
    for (const frame of assembler.push(bytes)) incoming.emit(frame);
  });
  // A dropped connection leaves half a frame behind; the next one starts clean.
  const stopState = channel.onConnectedChange((connected) => {
    if (!connected) assembler.reset();
  });

  const send = (frame: Uint8Array): Promise<void> => {
    try {
      guarded(frame);
    } catch (error) {
      return Promise.reject(error);
    }
    const run = queue.then(async () => {
      if (!channel.connected) throw new Error(`No Bluetooth connection to ${address}`);
      const wait = WRITE_SPACING_MS - (Date.now() - lastWrite);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastWrite = Date.now();
      await channel.write(frame);
    });
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    transport,
    address,
    get connected() {
      return channel.connected;
    },
    send,
    async request(frame, expect, timeoutMs = 8000) {
      const read = readOf(frame, expect);
      const answer = incoming.wait(
        (parsed) => answers(parsed, read),
        timeoutMs,
        `function 0x0${read.fn}`
      );
      try {
        await send(frame);
      } catch (error) {
        answer.cancel();
        throw error;
      }
      return answer.promise;
    },
    onFrame: incoming.add,
    onConnectedChange: (listener) => channel.onConnectedChange(listener),
    async close() {
      stopData();
      stopState();
      assembler.reset();
    },
  };
}

/** A Sydpower link over an open channel: a broker's topics, or a byte stream. */
export function linkOver(connection: { channel: Channel; address: string; transport: string }): SydpowerLink {
  const { channel, address, transport } = connection;
  switch (channel.kind) {
    case 'messages':
      return overMessages(channel, address);
    case 'bytes':
      return overBytes(channel, address, transport);
    case 'http':
      throw new Error('A Sydpower station does not speak HTTP');
  }
}
