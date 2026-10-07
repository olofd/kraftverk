import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { Socket } from 'node:net';

import type { Announcement, ByteChannel, Matcher, OpenOptions, Sighting, Transport, TransportContext, TransportFactory } from '@kraftverk/device-sdk';

import definition, { hostOf, isLocalAddress } from './index.ts';

/**
 * The home network, on the server: TCP connections to devices, and the UDP
 * broadcasts devices announce themselves with.
 *
 * Knows no protocol. Which UDP ports to listen on comes from the ways that
 * are found by a broadcast (a `broadcast` matcher), and what a broadcast
 * says is for the protocol to read — the transport hands over its bytes.
 * Everything one host says is one sighting. Listening happens while something
 * is watching; listening sends nothing, so a home watches all the time.
 */

/** A device not heard from in this long has left the list. */
const STALE_AFTER_MS = 60_000;
const CONNECT_TIMEOUT_MS = 5_000;

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** One TCP connection to one device, kept up: reconnected when it drops, with backoff. */
class TcpChannel implements ByteChannel {
  readonly kind = 'bytes' as const;
  #socket: Socket | null = null;
  #connected = false;
  #closed = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #backoffMs = 2000;
  #lastError: string | null = null;
  #attempts = 0;
  #data = new Set<(bytes: Uint8Array) => void>();
  #state = new Set<(connected: boolean) => void>();

  constructor(
    readonly address: string,
    readonly port: number,
    private release: () => void
  ) {}

  get connected(): boolean {
    return this.#connected;
  }

  #setConnected(connected: boolean): void {
    if (connected === this.#connected) return;
    this.#connected = connected;
    for (const listener of [...this.#state]) listener(connected);
  }

  onConnectedChange(listener: (connected: boolean) => void): () => void {
    this.#state.add(listener);
    return () => void this.#state.delete(listener);
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.#data.add(listener);
    return () => void this.#data.delete(listener);
  }

  connect(): void {
    if (this.#closed || this.#socket) return;
    this.#attempts += 1;
    const socket = new Socket();
    socket.setNoDelay(true);
    this.#socket = socket;
    const timeout = setTimeout(() => socket.destroy(new Error(`No answer from ${this.address}:${this.port} within ${CONNECT_TIMEOUT_MS} ms`)), CONNECT_TIMEOUT_MS);

    socket.on('connect', () => {
      clearTimeout(timeout);
      this.#backoffMs = 2000;
      this.#lastError = null;
      this.#setConnected(true);
    });
    socket.on('data', (chunk) => {
      const bytes = new Uint8Array(typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk);
      for (const listener of [...this.#data]) listener(bytes);
    });
    socket.on('error', (error) => {
      this.#lastError = error.message;
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      if (this.#socket === socket) this.#socket = null;
      this.#setConnected(false);
      this.#schedule();
    });
    socket.connect(this.port, this.address);
  }

  #schedule(delay = this.#backoffMs): void {
    if (this.#closed || this.#timer) return;
    this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.connect();
    }, delay);
  }

  async write(bytes: Uint8Array): Promise<void> {
    const socket = this.#socket;
    if (!socket || !this.#connected) throw new Error(`Not connected to ${this.address}`);
    await new Promise<void>((resolve, reject) => socket.write(bytes, (error) => (error ? reject(error) : resolve())));
  }

  /** A fresh connection, now: the old one is dropped and another made at once. */
  async reset(): Promise<void> {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    const old = this.#socket;
    this.#socket = null;
    if (old) {
      old.removeAllListeners();
      old.destroy();
    }
    this.#setConnected(false);
    this.#backoffMs = 2000;
    this.connect();
  }

  describe() {
    return { address: this.address, port: this.port, connected: this.#connected, lastError: this.#lastError, attempts: this.#attempts };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#socket?.removeAllListeners();
    this.#socket?.destroy();
    this.#socket = null;
    this.#setConnected(false);
    this.#data.clear();
    this.#state.clear();
    this.release();
  }
}

/** The latest a host said on one port. */
type Heard = { port: number; payload: Uint8Array; at: number };

const createLanTransport: TransportFactory = (context: TransportContext): Transport => {
  const channels = new Map<string, TcpChannel>();
  /** One socket per port, shared by every watcher that wants it. */
  const listeners = new Map<number, { socket: UdpSocket; users: number }>();
  /** By host, then by port: what each host last said on each. */
  const heard = new Map<string, Map<number, Heard>>();
  const watchers = new Set<() => void>();

  const listenOn = (port: number): void => {
    const existing = listeners.get(port);
    if (existing) {
      existing.users += 1;
      return;
    }
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (datagram, remote) => {
      const host = heard.get(remote.address) ?? new Map<number, Heard>();
      host.set(port, { port, payload: new Uint8Array(datagram), at: Date.now() });
      heard.set(remote.address, host);
      for (const notify of [...watchers]) notify();
    });
    socket.on('error', (error) => context.log('warn', `[lan] Listening on UDP ${port}: ${error.message}`));
    try {
      socket.bind(port);
      listeners.set(port, { socket, users: 1 });
    } catch (error) {
      // Another program holds it — another Tuya tool holds 6667 — and one port is usually enough.
      context.log('warn', `[lan] Could not listen on UDP ${port}: ${(error as Error).message}`);
    }
  };

  const stopListening = (port: number): void => {
    const entry = listeners.get(port);
    if (!entry) return;
    entry.users -= 1;
    if (entry.users > 0) return;
    listeners.delete(port);
    try {
      entry.socket.close();
    } catch {
      /* already closed */
    }
  };

  return {
    definition,
    available: () => ({ ok: true }),
    async start() {},
    async stop() {
      for (const channel of [...channels.values()]) await channel.close();
      for (const port of [...listeners.keys()]) {
        listeners.get(port)!.users = 1;
        stopListening(port);
      }
    },

    watch(matchers: readonly Matcher[], listener: (sightings: readonly Sighting[]) => void) {
      const ports = [...new Set(matchers.flatMap((matcher) => (matcher.kind === 'broadcast' ? [matcher.port] : [])))];
      for (const port of ports) listenOn(port);
      let pending: ReturnType<typeof setTimeout> | null = null;
      const emit = () => {
        const cutoff = Date.now() - STALE_AFTER_MS;
        const sightings: Sighting[] = [];
        for (const [address, host] of heard) {
          const recent = [...host.values()].filter((entry) => entry.at >= cutoff && ports.includes(entry.port));
          if (!recent.length) continue;
          sightings.push({
            transport: 'lan',
            address,
            seenAt: new Date(Math.max(...recent.map((entry) => entry.at))).toISOString(),
            heard: recent.map((entry): Announcement => ({ kind: 'broadcast', port: entry.port, payload: toHex(entry.payload) })),
          });
        }
        listener(sightings);
      };
      // Devices repeat themselves every few seconds; half a second of coalescing is plenty.
      const notify = () => {
        pending ??= setTimeout(() => {
          pending = null;
          emit();
        }, 500);
      };
      watchers.add(notify);
      emit();
      return () => {
        watchers.delete(notify);
        if (pending) clearTimeout(pending);
        for (const port of ports) stopListening(port);
      };
    },

    async open(address: string, options: OpenOptions) {
      if (!isLocalAddress(address)) throw new Error(`${address} is not on the home network`);
      if (!options.port) throw new Error('A connection on the home network needs a port');
      // One connection per address: a device behind a gateway (`host#child`) has one of its own to the host.
      const key = `${address}:${options.port}`;
      if (channels.has(key)) throw new Error(`${key} is already open`);
      const channel = new TcpChannel(hostOf(address), options.port, () => channels.delete(key));
      channels.set(key, channel);
      channel.connect();
      return channel;
    },

    diagnostics: {
      /** Every connection, and what it last saw go wrong. */
      channels: async () => [...channels.values()].map((channel) => channel.describe()),
    },
  };
};

export default createLanTransport;
