import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';

import {
  fullUuid,
  sightingMatches,
  type Availability,
  type ByteChannel,
  type Matcher,
  type OpenOptions,
  type Sighting,
  type Transport,
  type TransportContext,
  type TransportFactory,
} from '@kraftverk/device-sdk';

import { BluezRadio } from './bluez.ts';
import definition, { advertOf } from './index.ts';
import { NobleRadio } from './noble.ts';
import type { Advert, Link, Radio } from './radio.ts';

/**
 * Bluetooth LE on the server: through BlueZ on Linux — over the system bus,
 * the stack the machine already runs, which a container reaches through the
 * host's bus socket — and through noble elsewhere (radio.ts).
 *
 * Split in two, because the radio and a connection are different things. One
 * radio owns the scan, and there is genuinely one of those per process. A *connection* is not scarce in the same way: a central
 * holds several peripherals at once, commonly around seven. So the transport
 * scans and each channel connects, owning what a connection actually has — its
 * characteristics and its own reconnect loop.
 *
 * It knows no protocol. Which GATT layout to use comes from the protocol that
 * opens a channel (`OpenOptions.gatt`), and the channel hands back bytes as they
 * arrive: reassembling them into frames is the protocol's job.
 *
 * The scarcity that is real belongs to a device: many accept one connection at
 * a time, so the server competes with the app and the vendor's own for any
 * single unit.
 */

/** Drop a device from the list after this long without an advertisement. */
const STALE_AFTER_MS = 30_000;

/** How long a connection is given to be answered: a radio's own may wait for ever. */
const CONNECT_TIMEOUT_MS = 20_000;

/** `work`, or `said` once `ms` have passed without it. */
const within = <T>(work: Promise<T>, ms: number, said: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(said)), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

export type GattDiscovery = {
  at: string;
  services: string[];
  characteristics: { uuid: string; properties: string[] }[];
};

type Seen = {
  id: string;
  name: string | null;
  rssi: number | null;
  services: string[];
  manufacturer: Record<string, string>;
  firstSeen: string;
  lastSeen: string;
};

const sightingOf = (seen: Seen): Sighting => ({
  transport: 'ble',
  address: seen.id,
  seenAt: seen.lastSeen,
  ...(seen.name ? { name: seen.name } : {}),
  ...(seen.rssi !== null ? { rssi: seen.rssi } : {}),
  heard: [advertOf(seen.name, seen.services, seen.manufacturer)],
});

class BleServerTransport extends EventEmitter implements Transport {
  readonly definition = definition;

  #radio: Radio | null = null;
  #availability: Availability = { ok: false, reason: 'Bluetooth has not started' };
  #seen = new Map<string, Seen>();
  #channels = new Map<string, BleChannel>();

  constructor(private context: TransportContext) {
    super();
    this.setMaxListeners(0);
  }

  available(): Availability {
    return this.#availability;
  }

  async start(): Promise<void> {
    if (this.#radio) return;
    const radio = radioFor(this.context.env);
    // Its own before it starts: what it hears while starting may wake a channel, which connects through it.
    this.#radio = radio;
    try {
      await radio.start((advert) => this.#heard(advert));
      this.#availability = { ok: true };
      this.context.log('info', `[ble] Scanning for Bluetooth devices, through ${radio.name}`);
    } catch (error) {
      // Recorded, not thrown: a machine with no Bluetooth radio still serves
      // everything it reaches another way.
      this.#radio = null;
      const message = (error as Error).message;
      this.#availability = {
        ok: false,
        reason: /Cannot find (module|package)/.test(message) ? 'This server was installed without Bluetooth support' : `This server has no usable Bluetooth radio (${radio.name}): ${message}`,
      };
      this.context.log('warn', `[ble] Bluetooth is unavailable: ${message}`);
    }
  }

  #heard(advert: Advert): void {
    const { id } = advert;
    const now = new Date().toISOString();
    const existing = this.#seen.get(id);
    this.#seen.set(id, {
      id,
      name: advert.name || existing?.name || null,
      rssi: advert.rssi,
      services: advert.services.length ? advert.services : (existing?.services ?? []),
      manufacturer: Object.keys(advert.manufacturer).length ? advert.manufacturer : (existing?.manufacturer ?? {}),
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
    });
    if (!existing) this.emit('discovery');
    // A channel waiting for this peripheral can now try: this is what makes
    // opening one before the device is in range a normal thing to do.
    this.#channels.get(id)?.noteInRange();
  }

  /** Currently in range, strongest signal first. Open ones are kept whatever. */
  #current(): Seen[] {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [id, seen] of this.#seen) {
      if (this.#channels.has(id)) continue;
      if (Date.parse(seen.lastSeen) < cutoff) this.#seen.delete(id);
    }
    return [...this.#seen.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }

  async stop(): Promise<void> {
    for (const channel of [...this.#channels.values()]) await channel.close();
    await this.#radio?.stop().catch(() => {});
    this.#radio = null;
    this.#availability = { ok: false, reason: 'Bluetooth has stopped' };
  }

  watch(matchers: readonly Matcher[], listener: (sightings: readonly Sighting[]) => void): () => void {
    const emit = () => listener(this.#current().map(sightingOf).filter((sighting) => !matchers.length || sightingMatches(matchers, sighting)));
    emit();
    // Signal strength changes all the time; once a second is plenty.
    const timer = setInterval(emit, 1000);
    this.on('discovery', emit);
    return () => {
      clearInterval(timer);
      this.off('discovery', emit);
    };
  }

  /** The radio, while Bluetooth runs: what a channel connects through. */
  get radio(): Radio | null {
    return this.#radio;
  }

  async open(address: string, options: OpenOptions): Promise<ByteChannel> {
    // Refused rather than shared: two owners of one connection means two
    // sessions polling one device, and whichever closes first disconnects it
    // under the other. The core claims an address before opening it, so this
    // is a guard against a bug, not an expected outcome.
    if (this.#channels.has(address)) throw new Error(`${address} is already open`);
    if (!options.gatt?.length) throw new Error('A Bluetooth channel needs the GATT layout to use');

    const channel = new BleChannel(address, this, options, () => this.#channels.delete(address), this.context);
    this.#channels.set(address, channel);
    // One attempt now, so the caller hears promptly; failing is not fatal,
    // because the channel's own backoff keeps working at it. At weak signal
    // that is the difference between working and not.
    await channel.connect().catch(() => undefined);
    return channel;
  }

  gatt() {
    return [...this.#channels.values()].map((channel) => channel.describe());
  }
}

/**
 * One device's GATT connection: its write characteristic, its notifications,
 * and its reconnect loop. Per device, so two devices' bytes never meet.
 */
export class BleChannel implements ByteChannel {
  readonly kind = 'bytes' as const;

  #link: Link | null = null;
  #write: string | null = null;
  #connected = false;
  #connecting = false;
  #closed = false;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #backoffMs = 2000;
  #lastError: string | null = null;
  #attempts = 0;
  #lastDiscovery: GattDiscovery | null = null;
  #data = new Set<(bytes: Uint8Array) => void>();
  #state = new Set<(connected: boolean) => void>();

  constructor(
    readonly address: string,
    private transport: BleServerTransport,
    private options: OpenOptions,
    private release: () => void,
    private context: TransportContext
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

  /** The device advertised. Worth another try straight away. */
  noteInRange(): void {
    if (this.#connected || this.#connecting || this.#closed || this.#reconnectTimer) return;
    void this.connect().catch(() => this.#scheduleReconnect());
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer || this.#closed) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.connect().catch(() => this.#scheduleReconnect());
    }, delay);
  }

  async connect(): Promise<void> {
    if (this.#closed || this.#connecting || this.#connected) return;

    const radio = this.transport.radio;
    if (!radio || !radio.knows(this.address)) {
      // Not an error worth throwing at start-up: a saved device is routinely
      // out of range when the server boots, and the scan will bring it back.
      this.#lastError = `${this.address} is not in range`;
      this.#scheduleReconnect();
      throw new Error(this.#lastError);
    }

    this.#connecting = true;
    this.#attempts += 1;
    try {
      await this.#openGatt(radio);
      this.#lastError = null;
      this.#backoffMs = 2000;
    } catch (error) {
      this.#lastError = (error as Error).message;
      this.#scheduleReconnect();
      throw error;
    } finally {
      this.#connecting = false;
    }
  }

  /**
   * Connects, finds its layout and listens. Whatever stops it on the way —
   * a layout not there, a step that throws, the channel closed meanwhile —
   * lets go of the link it made: a station that takes one connection is not
   * left held by nobody, locked from the phone and its own app.
   */
  async #openGatt(radio: Radio): Promise<void> {
    try {
      await this.#gatt(radio);
    } catch (error) {
      this.#link = null;
      await radio.drop(this.address).catch(() => {});
      throw error;
    }
  }

  /** Closed while it connected: it stops here, and does not say it is connected. */
  #stillWanted(): void {
    if (this.#closed) throw new Error(`Closed while connecting to ${this.address}`);
  }

  async #gatt(radio: Radio): Promise<void> {
    // One that never answers is given up, so the next advertisement can try again.
    const link = await within(radio.connect(this.address), CONNECT_TIMEOUT_MS, `${this.address} did not answer the connection within ${CONNECT_TIMEOUT_MS / 1000} s`);
    this.#link = link;
    this.#stillWanted();
    const { services, characteristics } = link.gatt;
    this.#lastDiscovery = { at: new Date().toISOString(), services, characteristics };

    const short = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
    /** 1800/1801 are Generic Access and Generic Attribute — every device has them. */
    const onlyGenericServices = services.every((uuid) => ['1800', '1801'].includes(short(uuid).replace(/^0000|0000.*$/g, '')));
    const find = (want: string) => characteristics.find((characteristic) => fullUuid(characteristic.uuid) === fullUuid(want));

    let write: string | null = null;
    let notify: string | null = null;
    for (const candidate of this.options.gatt ?? []) {
      const w = find(candidate.write);
      const n = find(candidate.notify);
      if (w && n) {
        write = w.uuid;
        notify = n.uuid;
        break;
      }
    }

    if (!write || !notify) {
      const svc = services.join(', ') || 'none';
      const chr = characteristics.map((characteristic) => characteristic.uuid).join(', ') || 'none';
      throw new Error(
        onlyGenericServices
          ? `Only the standard GATT services are visible (${svc}). On Windows this means the ` +
              'device is not paired: WinRT hides custom services from unpaired peripherals. Pair it in ' +
              'Settings > Bluetooth & devices > Add device, then retry.'
          : `None of the GATT layouts this device is reached by is there. Services: ${svc}. Characteristics: ${chr}`
      );
    }

    await link.subscribe(notify, (bytes) => {
      for (const listener of [...this.#data]) listener(bytes);
    });
    this.#stillWanted();

    link.onDisconnect(() => {
      this.#write = null;
      this.#link = null;
      this.#lastError = 'The connection dropped';
      this.#setConnected(false);
      // Still this channel's device — keep trying to get it back.
      this.#scheduleReconnect();
    });

    this.#write = write;
    this.#setConnected(true);
    this.context.log('info', `[ble] Connected to ${this.address}`);
  }

  async write(bytes: Uint8Array): Promise<void> {
    const link = this.#link;
    if (!link || !this.#write) throw new Error(`No Bluetooth connection to ${this.address}`);
    await link.write(this.#write, bytes, this.options.writeWithResponse ?? true);
  }

  describe() {
    return {
      address: this.address,
      connected: this.#connected,
      lastError: this.#lastError,
      attempts: this.#attempts,
      discovery: this.#lastDiscovery,
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    if (this.#link) await this.#link.disconnect().catch(() => {});
    else await this.transport.radio?.drop(this.address).catch(() => {});
    this.#link = null;
    this.#write = null;
    this.#setConnected(false);
    this.#data.clear();
    this.#state.clear();
    this.release();
  }
}

/**
 * The radio to use: BlueZ where the system bus is — a Linux machine, or a
 * container given the host's — and noble everywhere else.
 */
function radioFor(env: Readonly<Record<string, string | undefined>>): Radio {
  const bus = (env.DBUS_SYSTEM_BUS_ADDRESS ?? 'unix:path=/run/dbus/system_bus_socket').replace(/^unix:path=/, '').split(',')[0]!;
  return process.platform === 'linux' && existsSync(bus) ? new BluezRadio() : new NobleRadio();
}

const createBleTransport: TransportFactory = (context) => {
  const transport = new BleServerTransport(context);
  return Object.assign(transport, {
    diagnostics: {
      /** What each connection's GATT enumeration returned, and how its attempts are going. */
      gatt: async () => ({ available: transport.available(), channels: transport.gatt() }),
    },
  });
};

export default createBleTransport;
