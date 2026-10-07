import { Socket } from 'node:net';

import type { ByteChannel, Matcher, OpenOptions, Sighting, Transport, TransportContext, TransportFactory } from '@kraftverk/device-sdk';

import definition, { hostOf, isLocalAddress } from './index.ts';
import { hearDirectly, type Hearing } from './listen.ts';
import { hearThroughRelay, relayToken } from './relay.ts';

/**
 * The home network, on the server: TCP connections to devices, and hearing
 * the devices that announce themselves — their broadcasts, their mDNS
 * services, their SSDP announcements.
 *
 * Knows no protocol. What to listen for comes from the ways that are found
 * by it (their `discovery` matchers), and what an announcement says is for
 * the protocol to read — the transport hands it over, typed. Everything one
 * host says is one sighting. Listening happens while something is watching;
 * it sends nothing but the questions mDNS and SSDP are asked with, so a
 * home watches all the time.
 *
 * Heard with this process's own sockets — or, for a server in a container,
 * which multicast and broadcasts do not reach, through the relay
 * (relay.ts): the one service on the home network, which hears for it.
 * `KRAFTVERK_LAN_RELAY_PORT` is the port the relay connects to; the token it
 * proves itself with is kept in `KRAFTVERK_LAN_RELAY_TOKEN_FILE`.
 */

const CONNECT_TIMEOUT_MS = 5_000;

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

/** How the transport hears the home network: through the relay when it is told its port, with its own sockets otherwise. */
function hearingFor(context: TransportContext): Hearing & { relay?: { connected(): boolean } } {
  const port = context.env.KRAFTVERK_LAN_RELAY_PORT;
  if (!port) return hearDirectly(context.log);
  const token = relayToken(context.env.KRAFTVERK_LAN_RELAY_TOKEN_FILE || '/relay/token', true)!;
  const relayed = hearThroughRelay({ port: Number(port), token, log: context.log });
  return { ...relayed, relay: relayed };
}

const createLanTransport: TransportFactory = (context: TransportContext): Transport => {
  const channels = new Map<string, TcpChannel>();
  let hearing: ReturnType<typeof hearingFor> | null = null;
  const heard = () => (hearing ??= hearingFor(context));

  return {
    definition,
    available: () => ({ ok: true }),
    async start() {
      // Ready for the relay from the start, when there is one: what it hears is wanted as soon as anything watches.
      heard();
    },
    async stop() {
      for (const channel of [...channels.values()]) await channel.close();
      hearing?.stop();
      hearing = null;
    },

    watch(matchers: readonly Matcher[], listener: (sightings: readonly Sighting[]) => void) {
      const hearing = heard();
      const release = hearing.want(matchers);
      let pending: ReturnType<typeof setTimeout> | null = null;
      const emit = () => listener(hearing.sightings(matchers));
      // Devices repeat themselves every few seconds; half a second of coalescing is plenty.
      const stopHearing = hearing.onHeard(() => {
        pending ??= setTimeout(() => {
          pending = null;
          emit();
        }, 500);
      });
      emit();
      return () => {
        stopHearing();
        if (pending) clearTimeout(pending);
        release();
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
      /** How the home network is heard: with this process's own sockets, or through the relay — and whether it is connected. */
      hearing: async () => (hearing?.relay ? { through: 'relay', connected: hearing.relay.connected() } : { through: 'own sockets' }),
    },
  };
};

export default createLanTransport;
