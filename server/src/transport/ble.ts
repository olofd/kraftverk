import { EventEmitter } from 'node:events';

import {
  FrameAssembler,
  isLikelyStation,
  SERVICE_CANDIDATES,
  STALE_AFTER_MS,
  WRITE_SPACING_MS,
  type ParsedFrame,
} from '@kraftverk/protocol';

import type { DiscoveredDevice, Transport } from './types.ts';

/**
 * Bluetooth LE transport, over noble.
 *
 * The station exposes a GATT service carrying the same MODBUS frames the MQTT
 * bridge uses: write a request to one characteristic, receive the response as a
 * notification on another. No handshake is needed after connecting.
 *
 * The GATT layout, the advertisement heuristics, the write spacing and the
 * frame reassembly are all in `@kraftverk/protocol`, shared with the app's Web
 * Bluetooth and react-native-ble-plx transports. Only noble's API is here.
 */

type Noble = typeof import('@stoprocent/noble').default;
type Peripheral = Awaited<ReturnType<Noble['startScanningAsync']>> extends never ? never : any;

export class BleTransport extends EventEmitter implements Transport {
  readonly kind = 'ble' as const;

  #noble: Noble | null = null;
  #devices = new Map<string, DiscoveredDevice>();
  #peripherals = new Map<string, Peripheral>();
  #boundId: string | null = null;
  #writeChar: any = null;
  #connected = false;
  #lastWrite = 0;
  /** Notifications can arrive split across packets. */
  #assembler = new FrameAssembler();

  // Connection keep-alive. BLE links drop routinely — especially at weak
  // signal — so binding sets a target and a loop works to keep it connected.
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #backoffMs = 2000;
  #connecting = false;
  #lastError: string | null = null;
  #attempts = 0;
  /** What the last GATT enumeration actually returned, for diagnostics. */
  #lastDiscovery: {
    at: string;
    services: string[];
    characteristics: { uuid: string; properties: string[] }[];
  } | null = null;

  get lastError(): string | null {
    return this.#lastError;
  }

  get lastDiscovery() {
    return this.#lastDiscovery;
  }

  get attempts(): number {
    return this.#attempts;
  }

  get boundId(): string | null {
    return this.#boundId;
  }

  get connected(): boolean {
    return this.#connected;
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
      if (id === this.#boundId) continue; // keep the target visible
      if (new Date(device.lastSeen).getTime() < cutoff) {
        this.#devices.delete(id);
        this.#peripherals.delete(id);
      }
    }
  }

  async stop(): Promise<void> {
    await this.unbind();
    await this.#noble?.stopScanningAsync().catch(() => {});
    this.#noble = null;
  }

  /** Currently in range, strongest signal first. */
  discovered(): DiscoveredDevice[] {
    this.#prune();
    return [...this.#devices.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
  }

  /**
   * Targets a station and keeps it connected.
   *
   * One connect attempt runs inline so the caller gets immediate feedback, but
   * a failure is not fatal: a backoff loop keeps retrying, and reconnects if
   * the link drops later. At weak signal that is the difference between working
   * and not.
   */
  async bind(id: string): Promise<void> {
    if (!this.#peripherals.has(id)) throw new Error(`No BLE device with id ${id}. Scan first.`);

    await this.unbind();
    this.#boundId = id;
    this.#backoffMs = 2000;

    try {
      await this.#connect();
    } catch (error) {
      // Keep the binding and let the loop retry; report the first failure.
      this.#scheduleReconnect();
      throw error;
    }
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer || !this.#boundId) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect().catch(() => this.#scheduleReconnect());
    }, delay);
  }

  async #connect(): Promise<void> {
    const id = this.#boundId;
    if (!id || this.#connecting || this.#connected) return;

    const peripheral = this.#peripherals.get(id);
    if (!peripheral) throw new Error(`Device ${id} is no longer in range`);

    this.#connecting = true;
    this.#attempts += 1;
    try {
      await this.#openGatt(peripheral);
      this.#lastError = null;
      this.#backoffMs = 2000;
    } catch (error) {
      this.#lastError = (error as Error).message;
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
      // Still bound — keep trying to get it back.
      this.#scheduleReconnect();
    });

    this.#writeChar = writeChar;
    this.#connected = true;
  }

  async unbind(): Promise<void> {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;

    const current = this.#boundId ? this.#peripherals.get(this.#boundId) : null;
    if (current) await current.disconnectAsync().catch(() => {});
    this.#boundId = null;
    this.#writeChar = null;
    this.#connected = false;
    this.#assembler.reset();
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
    if (!characteristic) throw new Error('No BLE device bound');

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

  onDiscovery(listener: (device: DiscoveredDevice) => void): () => void {
    this.on('discovery', listener);
    return () => this.off('discovery', listener);
  }
}
