import { EventEmitter } from 'node:events';

import {
  FrameAssembler,
  isLikelyStation,
  SERVICE_CANDIDATES,
  STALE_AFTER_MS,
  WRITE_SPACING_MS,
  type ParsedFrame,
} from '@kraftverk/protocol';

import { stationId, type StationId } from '@kraftverk/plugin-sdk';

import type { DiscoveredDevice, ServerLink, TransportHost } from './types.ts';

/**
 * Bluetooth LE, over noble.
 *
 * The station exposes a GATT service carrying the same MODBUS frames the MQTT
 * bridge uses: write a request to one characteristic, receive the response as a
 * notification on another. No handshake is needed after connecting.
 *
 * Split in two, because the adapter and a connection are different things. One
 * noble instance owns the radio and the scan — there is genuinely only one of
 * those per process. A *connection* is not scarce in the same way: a BLE
 * central holds several peripherals at once, commonly around seven. The old
 * single class conflated them, keeping one set of characteristics, one frame
 * assembler and one reconnect loop, which is why a second station could not be
 * held rather than why it *should* not be.
 *
 * The constraint that survives is real but different: a given station accepts
 * one connection at a time, so the server still competes with the app and with
 * BrightEMS for any single unit.
 */

type Noble = typeof import('@stoprocent/noble').default;
type Peripheral = Awaited<ReturnType<Noble['startScanningAsync']>> extends never ? never : any;

export type GattDiscovery = {
  at: string;
  services: string[];
  characteristics: { uuid: string; properties: string[] }[];
};

export class BleHost extends EventEmitter implements TransportHost {
  readonly kind = 'ble' as const;

  #noble: Noble | null = null;
  #devices = new Map<string, DiscoveredDevice>();
  #peripherals = new Map<string, Peripheral>();
  #links = new Map<StationId, BleLink>();

  /**
   * Diagnostics, aggregated across links.
   *
   * The GATT enumeration and the last failure belong to a connection, not to
   * the adapter — but `/api/diagnostics/gatt` is still a global route, so the
   * host keeps the most recent of each. Per-link detail is on the link.
   */
  #lastError: string | null = null;
  #attempts = 0;
  #lastDiscovery: GattDiscovery | null = null;

  get lastError(): string | null {
    return this.#lastError;
  }

  get attempts(): number {
    return this.#attempts;
  }

  get lastDiscovery(): GattDiscovery | null {
    return this.#lastDiscovery;
  }

  /** True when any link is up. The global routes ask this; a link knows better. */
  get connected(): boolean {
    return [...this.#links.values()].some((link) => link.connected);
  }

  async start(): Promise<void> {
    const noble = (await import('@stoprocent/noble')).default;
    this.#noble = noble;

    noble.on('discover', (peripheral: Peripheral) => {
      const name: string = peripheral.advertisement?.localName ?? '';
      const id: string = peripheral.id;
      const now = new Date().toISOString();
      const existing = this.#devices.get(id);

      /**
       * Advertised service UUIDs are far stronger evidence than a name: plenty
       * of nearby peripherals advertise nothing at all, and an earlier version
       * of this filter let unnamed devices through and auto-connected to a
       * stranger's fitness tracker. `isLikelyStation` is the shared rule.
       */
      const device: DiscoveredDevice = {
        id,
        kind: 'ble',
        name: name || 'Unnamed BLE device',
        mac: (peripheral.address ?? '').replace(/:/g, '').toUpperCase() || null,
        rssi: peripheral.rssi,
        firstSeen: existing?.firstSeen ?? now,
        lastSeen: now,
        // Only these are safe to connect to unprompted.
        likelyStation: isLikelyStation({
          name,
          serviceUuids: peripheral.advertisement?.serviceUuids ?? [],
        }),
      };

      this.#peripherals.set(id, peripheral);
      this.#devices.set(id, device);
      // Only announce the first sighting; duplicates just refresh rssi/lastSeen.
      if (!existing) this.emit('discovery', device);

      // A link waiting for this peripheral can now try: this is what makes
      // opening a link before the station is in range a normal thing to do.
      this.#links.get(stationId(id))?.noteInRange();
    });

    await new Promise<void>((resolve, reject) => {
      if (noble.state === 'poweredOn') return resolve();
      const timer = setTimeout(() => reject(new Error('No Bluetooth adapter became available')), 8000);
      noble.once('stateChange', (state: string) => {
        clearTimeout(timer);
        state === 'poweredOn' ? resolve() : reject(new Error(`Bluetooth adapter is ${state}`));
      });
    });

    // allowDuplicates: repeated advertisements from a device we already know
    // are what keep rssi and lastSeen current. Without this each device is
    // reported exactly once and the signal reading freezes at first sighting —
    // useless when you are moving an antenna to improve it.
    await noble.startScanningAsync([], true);
  }

  /**
   * Devices stop advertising when they sleep, move out of range, or power off.
   * Nothing tells us that happened, so treat silence as gone.
   */
  #prune(): void {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [id, device] of this.#devices) {
      if (this.#links.has(stationId(id))) continue; // keep every linked station visible
      if (new Date(device.lastSeen).getTime() < cutoff) {
        this.#devices.delete(id);
        this.#peripherals.delete(id);
      }
    }
  }

  async stop(): Promise<void> {
    for (const link of [...this.#links.values()]) await link.close();
    await this.#noble?.stopScanningAsync().catch(() => {});
    this.#noble = null;
  }

  /** Currently in range, strongest signal first. */
  discovered(): DiscoveredDevice[] {
    this.#prune();
    return [...this.#devices.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }

  onDiscovery(listener: (device: DiscoveredDevice) => void): () => void {
    this.on('discovery', listener);
    return () => this.off('discovery', listener);
  }

  openIds(): StationId[] {
    return [...this.#links.keys()];
  }

  /** The peripheral for an id, if it has been seen. Used by links. */
  peripheral(id: StationId): Peripheral | null {
    return this.#peripherals.get(id) ?? null;
  }

  /** Links report here so the global diagnostics routes still have an answer. */
  report(update: { error?: string | null; attempt?: boolean; discovery?: GattDiscovery }): void {
    if (update.attempt) this.#attempts += 1;
    if (update.error !== undefined) this.#lastError = update.error;
    if (update.discovery) this.#lastDiscovery = update.discovery;
  }

  async open(station: StationId): Promise<ServerLink> {
    // Refused rather than shared: two owners of one link means two drivers
    // polling one station, and whichever closes first disconnects it under the
    // other. The manager claims a station before opening it, so reaching this
    // is a bug worth hearing about rather than a case to absorb.
    if (this.#links.has(station)) throw new Error(`${station} is already linked`);

    const link = new BleLink(station, this, () => this.#links.delete(station));
    this.#links.set(station, link);

    // One attempt inline so the caller gets immediate feedback; failing is not
    // fatal, because the link's own backoff loop keeps working at it. At weak
    // signal that is the difference between working and not.
    await link.connect().catch(() => undefined);
    return link;
  }
}

/**
 * One station's GATT connection.
 *
 * Everything here used to be a singleton field on the transport: the write
 * characteristic, the frame assembler that reassembles a 168-byte response from
 * several notifications, and the reconnect loop. Per-station is where they
 * belong — two stations reassembling into one buffer would interleave into
 * nonsense.
 */
export class BleLink extends EventEmitter implements ServerLink {
  readonly kind = 'ble' as const;

  #id: StationId;
  #host: BleHost;
  #release: () => void;

  #writeChar: any = null;
  #connected = false;
  #lastWrite = 0;
  /** Notifications can arrive split across packets. */
  #assembler = new FrameAssembler();

  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #backoffMs = 2000;
  #connecting = false;
  #closed = false;
  #lastError: string | null = null;
  #attempts = 0;
  #lastDiscovery: GattDiscovery | null = null;

  constructor(id: StationId, host: BleHost, release: () => void) {
    super();
    this.#id = id;
    this.#host = host;
    this.#release = release;
  }

  get boundId(): StationId {
    return this.#id;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  get attempts(): number {
    return this.#attempts;
  }

  get lastDiscovery(): GattDiscovery | null {
    return this.#lastDiscovery;
  }

  /** The host saw this station advertise. Worth another try straight away. */
  noteInRange(): void {
    if (this.#connected || this.#connecting || this.#closed) return;
    if (this.#reconnectTimer) return;
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

    const peripheral = this.#host.peripheral(this.#id);
    if (!peripheral) {
      // Not an error worth throwing at startup: a saved station is routinely
      // out of range when the server boots, and the scan will bring it back.
      const message = `Device ${this.#id} is not in range`;
      this.#lastError = message;
      this.#host.report({ error: message });
      this.#scheduleReconnect();
      throw new Error(message);
    }

    this.#connecting = true;
    this.#attempts += 1;
    this.#host.report({ attempt: true });
    try {
      await this.#openGatt(peripheral);
      this.#lastError = null;
      this.#host.report({ error: null });
      this.#backoffMs = 2000;
    } catch (error) {
      this.#lastError = (error as Error).message;
      this.#host.report({ error: this.#lastError });
      this.#scheduleReconnect();
      throw error;
    } finally {
      this.#connecting = false;
    }
  }

  async #openGatt(peripheral: Peripheral): Promise<void> {
    await peripheral.connectAsync();

    let { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();

    const short = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
    /** 1800/1801 are Generic Access and Generic Attribute — every device has them. */
    const onlyGenericServices = (list: any[]) =>
      list.every((s: any) => ['1800', '1801'].includes(short(s.uuid).replace(/^0000|0000.*$/g, '')));

    // Windows sometimes returns a partial GATT database on the first pass, and
    // for an unpaired peripheral it returns only 1800/1801 permanently (WinRT
    // hides custom services until the device is bonded). A retry costs little
    // and fixes the transient case; the permanent case is reported below.
    if (services.length === 0 || onlyGenericServices(services)) {
      await new Promise((r) => setTimeout(r, 1200));
      const retry = await peripheral.discoverAllServicesAndCharacteristicsAsync();
      if (retry.services.length > services.length) {
        services = retry.services;
        characteristics = retry.characteristics;
      }
    }

    this.#lastDiscovery = {
      at: new Date().toISOString(),
      services: services.map((s: any) => s.uuid),
      characteristics: characteristics.map((c: any) => ({
        uuid: c.uuid,
        properties: c.properties ?? [],
      })),
    };
    this.#host.report({ discovery: this.#lastDiscovery });

    const find = (want: string) =>
      characteristics.find((c: any) => {
        const u = short(c.uuid);
        return u === want || u === `0000${want}00001000800000805f9b34fb`;
      });

    let writeChar: any = null;
    let notifyChar: any = null;

    for (const candidate of SERVICE_CANDIDATES) {
      const w = find(candidate.write);
      const n = find(candidate.notify);
      if (w && n) {
        writeChar = w;
        notifyChar = n;
        break;
      }
    }

    // Last resort: any writable characteristic paired with any notifying one,
    // in the same non-generic service. Covers a vendor layout we don't know.
    if (!writeChar || !notifyChar) {
      const vendor = characteristics.filter((c: any) => {
        const u = short(c.uuid);
        return !u.startsWith('00002a') && !['1800', '1801'].includes(u);
      });
      const w = vendor.find((c: any) =>
        (c.properties ?? []).some((p: string) => p === 'write' || p === 'writeWithoutResponse')
      );
      const n = vendor.find((c: any) =>
        (c.properties ?? []).some((p: string) => p === 'notify' || p === 'indicate')
      );
      if (w && n) {
        console.log(
          `[ble] unknown GATT layout; using write=${w.uuid} notify=${n.uuid} by capability`
        );
        writeChar = w;
        notifyChar = n;
      }
    }

    if (!writeChar || !notifyChar) {
      await peripheral.disconnectAsync().catch(() => {});
      const svc = services.map((s: any) => s.uuid).join(', ') || 'none';
      const chr = characteristics.map((c: any) => c.uuid).join(', ') || 'none';
      const generic = onlyGenericServices(services);
      throw new Error(
        generic
          ? `Only the standard GATT services are visible (${svc}). On Windows this means the ` +
            `device is not paired: WinRT hides custom services from unpaired peripherals, so ` +
            `1800/1801 is all we ever get. Pair the station in Settings > Bluetooth & devices > ` +
            `Add device, then retry.`
          : `No usable characteristics. Services: ${svc}. Characteristics: ${chr}`
      );
    }

    notifyChar.removeAllListeners('data');
    notifyChar.on('data', (data: Buffer) => this.#onNotification(data));
    await notifyChar.subscribeAsync();

    peripheral.removeAllListeners('disconnect');
    peripheral.once('disconnect', () => {
      this.#connected = false;
      this.#writeChar = null;
      this.#assembler.reset();
      this.#lastError = 'Link dropped';
      // Still this link's station — keep trying to get it back.
      this.#scheduleReconnect();
    });

    this.#writeChar = writeChar;
    this.#connected = true;
  }

  /**
   * BLE splits payloads at the MTU, so a 168-byte telemetry response arrives in
   * several packets. The assembler owns that reassembly, and is shared with the
   * app's Bluetooth transports.
   */
  #onNotification(data: Buffer): void {
    for (const frame of this.#assembler.push(data)) this.emit('frame', frame);
  }

  async send(frame: Uint8Array): Promise<void> {
    const characteristic = this.#writeChar;
    if (!characteristic) throw new Error(`No BLE connection to ${this.#id}`);

    const wait = WRITE_SPACING_MS - (Date.now() - this.#lastWrite);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.#lastWrite = Date.now();

    // `false` = write with response, which the device requires.
    await characteristic.writeAsync(Buffer.from(frame), false);
  }

  async request(
    frame: Uint8Array,
    expect: 'input' | 'holding',
    timeoutMs = 8000
  ): Promise<ParsedFrame> {
    const wantFn = expect === 'input' ? 0x04 : 0x03;

    return new Promise<ParsedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('frame', onFrame);
        reject(new Error(`BLE timeout after ${timeoutMs}ms waiting for fn 0x0${wantFn}`));
      }, timeoutMs);

      const onFrame = (parsed: ParsedFrame) => {
        if (parsed.kind !== 'registers' || parsed.fn !== wantFn) return;
        clearTimeout(timer);
        this.off('frame', onFrame);
        resolve(parsed);
      };

      this.on('frame', onFrame);

      this.send(frame).catch((err) => {
        clearTimeout(timer);
        this.off('frame', onFrame);
        reject(err);
      });
    });
  }

  onFrame(listener: (frame: ParsedFrame) => void): () => void {
    this.on('frame', listener);
    return () => this.off('frame', listener);
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;

    const peripheral = this.#host.peripheral(this.#id);
    if (peripheral) await peripheral.disconnectAsync().catch(() => {});

    this.#writeChar = null;
    this.#connected = false;
    this.#assembler.reset();
    this.removeAllListeners();
    this.#release();
  }
}
