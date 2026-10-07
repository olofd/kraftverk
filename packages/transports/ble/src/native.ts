/// <reference path="../types/react-native-ble-plx.d.ts" />

import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';

import { fullUuid, sightingMatches, type Availability, type ByteChannel, type Matcher, type OpenOptions, type Sighting, type Transport, type TransportContext, type TransportFactory } from '@kraftverk/device-sdk';

import definition, { advertOf } from './index.ts';

/**
 * Bluetooth LE from a phone, over react-native-ble-plx.
 *
 * **It needs a development build.** The library is a native module that Expo
 * Go does not contain, so the app resolves it to nothing when it is absent
 * (client/metro.config.js) and this transport says, in `available()`, what to
 * install. iOS never reveals a MAC either: the address is a per-app id.
 */

export const NATIVE_BLE_SETUP =
  'Bluetooth from this phone needs a development build with react-native-ble-plx: install it, add the ' +
  'Bluetooth usage strings to app.json, then run npx expo run:ios. Expo Go cannot load native modules.';

const installed = (): boolean => typeof BleManager === 'function';

/** Silence this long from an advertiser means it has gone. */
const STALE_MS = 60_000;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes to base64, written out because Hermes has neither Buffer nor btoa. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const triple = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += BASE64[(triple >> 18) & 63]! + BASE64[(triple >> 12) & 63]!;
    out += b === undefined ? '=' : BASE64[(triple >> 6) & 63]!;
    out += c === undefined ? '=' : BASE64[triple & 63]!;
  }
  return out;
}

export function fromBase64(value: string): Uint8Array {
  const clean = value.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let byte = 0;
  let bits = 0;
  let written = 0;
  for (const char of clean) {
    const index = BASE64.indexOf(char);
    if (index < 0) continue;
    byte = (byte << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (byte >> bits) & 0xff;
    }
  }
  return out.subarray(0, written);
}

class NativeBleChannel implements ByteChannel {
  readonly kind = 'bytes' as const;
  #device: Device | null = null;
  #layout: { service: string; write: string; notify: string } | null = null;
  #subscriptions: Subscription[] = [];
  #connected = false;
  #closed = false;
  #connecting: Promise<void> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #backoffMs = 2000;
  #lastError: string | null = null;
  #data = new Set<(bytes: Uint8Array) => void>();
  #state = new Set<(connected: boolean) => void>();

  constructor(
    readonly address: string,
    private manager: () => BleManager,
    private handle: () => Device | null,
    private options: OpenOptions,
    private log: TransportContext['log']
  ) {
    void this.#connect();
  }

  get connected(): boolean {
    return this.#connected;
  }

  onConnectedChange(listener: (connected: boolean) => void): () => void {
    this.#state.add(listener);
    return () => void this.#state.delete(listener);
  }

  onData(listener: (bytes: Uint8Array) => void): () => void {
    this.#data.add(listener);
    return () => void this.#data.delete(listener);
  }

  async write(bytes: Uint8Array): Promise<void> {
    const device = this.#device;
    const layout = this.#layout;
    if (!device || !layout || !this.#connected) throw new Error('Not connected over Bluetooth');
    await device.writeCharacteristicWithResponseForService(fullUuid(layout.service), fullUuid(layout.write), toBase64(bytes));
  }

  async reset(): Promise<void> {
    await this.#teardown();
    this.#setConnected(false);
    await this.#connect();
  }

  /** The device advertised again: worth trying now rather than at the next backoff. */
  noteInRange(): void {
    if (this.#connected || this.#connecting || this.#closed) return;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    void this.#connect();
  }

  describe(): Record<string, unknown> {
    return { address: this.address, connected: this.#connected, layout: this.#layout, lastError: this.#lastError };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    await this.#teardown();
    this.#setConnected(false);
  }

  #setConnected(connected: boolean): void {
    if (connected === this.#connected) return;
    this.#connected = connected;
    for (const listener of [...this.#state]) listener(connected);
  }

  #schedule(): void {
    if (this.#closed || this.#retry) return;
    const delay = this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, 30_000);
    this.#retry = setTimeout(() => {
      this.#retry = null;
      void this.#connect();
    }, delay);
  }

  #connect(): Promise<void> {
    this.#connecting ??= (async () => {
      // The link made, until it is this channel's: let go of if anything stops it on the way.
      let reached: { cancelConnection(): Promise<unknown> } | null = null;
      // Closed while it connected: it stops, and does not say it is connected.
      const stillWanted = () => {
        if (this.#closed) throw new Error(`Closed while connecting to ${this.address}`);
      };
      try {
        if (this.#closed) return;
        const known = this.handle();
        const device = known
          ? await known.connect()
          : // A device seen in an earlier run: the phone can still connect by its id.
            await this.manager().connectToDevice(this.address);
        reached = device;
        stillWanted();
        const ready = await device.discoverAllServicesAndCharacteristics();
        stillWanted();
        const services = (await ready.services()).map((service) => service.uuid.toLowerCase());
        const layout = (this.options.gatt ?? []).find((candidate) => services.includes(fullUuid(candidate.service)));
        if (!layout) {
          await ready.cancelConnection().catch(() => undefined);
          throw new Error('Connected, but none of the expected services are there. Close any other app holding the device.');
        }
        this.#device = ready;
        this.#layout = layout;
        this.#subscriptions = [
          ready.monitorCharacteristicForService(fullUuid(layout.service), fullUuid(layout.notify), (error, characteristic) => {
            if (error || !characteristic?.value) return;
            const bytes = fromBase64(characteristic.value);
            for (const listener of [...this.#data]) listener(bytes);
          }),
          this.manager().onDeviceDisconnected(ready.id, () => {
            this.#setConnected(false);
            this.#schedule();
          }),
        ];
        stillWanted();
        this.#backoffMs = 2000;
        this.#lastError = null;
        this.#setConnected(true);
      } catch (error) {
        this.#lastError = (error as Error).message;
        if (!this.#closed) this.log('warn', `[ble] ${this.address}: ${this.#lastError}`);
        await this.#teardown();
        await reached?.cancelConnection().catch(() => undefined);
        this.#schedule();
      } finally {
        this.#connecting = null;
      }
    })();
    return this.#connecting;
  }

  async #teardown(): Promise<void> {
    for (const subscription of this.#subscriptions) subscription.remove();
    this.#subscriptions = [];
    const device = this.#device;
    this.#device = null;
    this.#layout = null;
    await device?.cancelConnection().catch(() => undefined);
  }
}

const createNativeBleTransport: TransportFactory = (context: TransportContext): Transport => {
  let manager: BleManager | null = null;
  let powered: string | null = null;
  const handles = new Map<string, Device>();
  const seen = new Map<string, Sighting>();
  const channels = new Map<string, NativeBleChannel>();
  const watchers = new Set<{ matchers: readonly Matcher[]; listener: (sightings: readonly Sighting[]) => void }>();
  let scanning = false;

  const managerOf = (): BleManager => {
    if (!manager) throw new Error('Bluetooth is not started');
    return manager;
  };

  const announce = () => {
    const cutoff = Date.now() - STALE_MS;
    for (const [address, sighting] of seen) if (Date.parse(sighting.seenAt) < cutoff) seen.delete(address);
    for (const watcher of watchers) {
      watcher.listener([...seen.values()].filter((sighting) => !watcher.matchers.length || sightingMatches(watcher.matchers, sighting)));
    }
  };

  const scan = () => {
    if (scanning || !manager || !watchers.size) return;
    scanning = true;
    // Wide, not by service: these units do not reliably advertise theirs.
    manager.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
      if (error || !device) return;
      handles.set(device.id, device);
      seen.set(device.id, {
        transport: 'ble',
        address: device.id,
        name: device.name ?? device.localName ?? undefined,
        rssi: device.rssi ?? undefined,
        seenAt: new Date().toISOString(),
        heard: [advertOf(device.name ?? device.localName ?? null, device.serviceUUIDs ?? [])],
      });
      channels.get(device.id)?.noteInRange();
      announce();
    });
  };

  const stopScan = () => {
    if (!scanning) return;
    scanning = false;
    manager?.stopDeviceScan();
  };

  return {
    definition,

    available(): Availability {
      if (!installed()) return { ok: false, reason: NATIVE_BLE_SETUP };
      if (powered && powered !== 'PoweredOn') return { ok: false, reason: `Bluetooth is ${powered.toLowerCase()}. Turn it on.` };
      return { ok: true };
    },

    async start() {
      if (!installed()) return;
      manager ??= new BleManager();
      powered = await manager.state();
      manager.onStateChange((state) => {
        powered = state;
      }, true);
    },

    async stop() {
      stopScan();
      for (const channel of channels.values()) await channel.close();
      channels.clear();
      manager?.destroy();
      manager = null;
    },

    watch(matchers, listener) {
      const watcher = { matchers, listener };
      watchers.add(watcher);
      scan();
      announce();
      return () => {
        watchers.delete(watcher);
        if (!watchers.size) stopScan();
      };
    },

    async open(address, options) {
      if (!manager) throw new Error(installed() ? 'Bluetooth is not started' : NATIVE_BLE_SETUP);
      const channel = new NativeBleChannel(address, managerOf, () => handles.get(address) ?? null, options, context.log);
      channels.set(address, channel);
      const close = channel.close.bind(channel);
      channel.close = async () => {
        channels.delete(address);
        await close();
      };
      return channel;
    },
  };
};

export default createNativeBleTransport;
