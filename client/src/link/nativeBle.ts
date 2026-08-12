import { BleManager, type Device, type Subscription } from 'react-native-ble-plx';

import {
  BLE_SERVICE_UUIDS,
  fullUuid,
  isLikelyStation,
  SERVICE_CANDIDATES,
  STALE_AFTER_MS,
  type DiscoveredDevice,
} from '@kraftverk/protocol';

import { DirectBleTransport } from './base';

/**
 * A station reached straight from the phone, over react-native-ble-plx.
 *
 * Same protocol package as the server and as the browser transport, so the
 * decode and the write rules are identical no matter which link the app is on.
 * Only the Bluetooth API differs — here it hands frames over as base64 strings,
 * which is the one real wrinkle.
 *
 * **This needs a development build.** react-native-ble-plx is a native module
 * and Expo Go does not contain it, so `installed()` is false there and the UI
 * says so rather than failing at a tap.
 */

/** True when the native library is actually present in this binary. */
export const nativeBleInstalled = (): boolean => typeof BleManager === 'function';

export const NATIVE_BLE_SETUP =
  'Direct Bluetooth on a phone needs a development build: install react-native-ble-plx, ' +
  'add the Bluetooth usage strings to app.json, then run `npx expo run:ios`. Expo Go cannot ' +
  'load native modules. Until then, connect through the server instead.';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Bytes to base64. Written out because Hermes has no Buffer and no btoa. */
function toBase64(bytes: Uint8Array): string {
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

/** Base64 back to bytes. */
function fromBase64(value: string): Uint8Array {
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

export class NativeBleTransport extends DirectBleTransport {
  readonly kind = 'direct-native-ble' as const;

  #manager: BleManager | null = null;
  #handles = new Map<string, Device>();
  #boundId: string | null = null;
  #device: Device | null = null;
  #layout: (typeof SERVICE_CANDIDATES)[number] | null = null;
  #notification: Subscription | null = null;
  #disconnection: Subscription | null = null;
  #connected = false;
  #scanning = false;

  get boundId(): string | null {
    return this.#boundId;
  }

  get connected(): boolean {
    return this.#connected;
  }

  get scanning(): boolean {
    return this.#scanning;
  }

  async start(): Promise<void> {
    if (!nativeBleInstalled()) throw new Error(NATIVE_BLE_SETUP);
    this.#manager ??= new BleManager();

    // The adapter is usually still powering on when the app launches.
    const state = await this.#manager.state();
    if (state !== 'PoweredOn') {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          subscription.remove();
          reject(new Error(`Bluetooth is ${state.toLowerCase()}. Turn it on and try again.`));
        }, 8000);
        const subscription = this.#manager!.onStateChange((next) => {
          if (next !== 'PoweredOn') return;
          clearTimeout(timer);
          subscription.remove();
          resolve();
        }, true);
      });
    }
  }

  /**
   * Scans for stations.
   *
   * Filtering by service UUID would be tidier, but these units do not reliably
   * advertise theirs, so scan wide and let `isLikelyStation` mark which results
   * are safe to connect to unprompted.
   */
  scan(seconds = 10): void {
    const manager = this.#manager;
    if (!manager) throw new Error('Bluetooth is not started');

    this.#scanning = true;
    manager.startDeviceScan(null, { allowDuplicates: true }, (error, device) => {
      if (error || !device) return;

      const name = device.name ?? device.localName ?? '';
      const now = new Date().toISOString();

      this.#handles.set(device.id, device);
      this.announce({
        id: device.id,
        kind: this.kind,
        name: name || 'Unnamed Bluetooth device',
        // iOS gives an opaque per-app UUID, never the MAC.
        mac: null,
        rssi: device.rssi ?? undefined,
        firstSeen: now,
        lastSeen: now,
        likelyStation: isLikelyStation({ name, serviceUuids: device.serviceUUIDs ?? [] }),
      });

      // Keep the signal reading current: it is what tells you whether moving
      // the phone closer is helping.
      const known = this.devices.get(device.id);
      if (known) this.devices.set(device.id, { ...known, lastSeen: now, rssi: device.rssi ?? undefined });
    });

    setTimeout(() => this.stopScan(), seconds * 1000);
  }

  stopScan(): void {
    if (!this.#scanning) return;
    this.#scanning = false;
    this.#manager?.stopDeviceScan();
    this.#prune();
  }

  /** Devices stop advertising when they sleep or move away; treat silence as gone. */
  #prune(): void {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [id, device] of this.devices) {
      if (id === this.#boundId) continue;
      if (new Date(device.lastSeen).getTime() < cutoff) {
        this.devices.delete(id);
        this.#handles.delete(id);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopScan();
    await this.unbind();
    this.#manager?.destroy();
    this.#manager = null;
  }

  async bind(id: string): Promise<void> {
    const handle = this.#handles.get(id);
    if (!handle) throw new Error(`No station with id ${id}. Scan again.`);

    await this.unbind();
    this.stopScan();
    this.#boundId = id;
    this.assembler.reset();

    const device = await (await handle.connect()).discoverAllServicesAndCharacteristics();
    this.#device = device;

    const services = (await device.services()).map((service) => service.uuid);
    const layout = SERVICE_CANDIDATES.find((candidate) =>
      services.some((uuid) => uuid.toLowerCase() === fullUuid(candidate.service))
    );

    if (!layout) {
      await device.cancelConnection().catch(() => {});
      this.#device = null;
      throw new Error(
        `Connected, but none of the known services are present (looked for ${BLE_SERVICE_UUIDS.join(', ')}). ` +
          `Close the vendor app — these units accept one connection at a time.`
      );
    }

    this.#layout = layout;
    this.#notification = device.monitorCharacteristicForService(
      fullUuid(layout.service),
      fullUuid(layout.notify),
      (error, characteristic) => {
        if (error || !characteristic?.value) return;
        this.ingest(fromBase64(characteristic.value));
      }
    );

    this.#disconnection = this.#manager!.onDeviceDisconnected(device.id, () => {
      this.#connected = false;
      this.assembler.reset();
    });

    this.#connected = true;
  }

  async unbind(): Promise<void> {
    this.#notification?.remove();
    this.#disconnection?.remove();
    this.#notification = null;
    this.#disconnection = null;

    if (this.#device) await this.#device.cancelConnection().catch(() => {});

    this.#device = null;
    this.#layout = null;
    this.#boundId = null;
    this.#connected = false;
    this.assembler.reset();
  }

  protected async writeFrame(frame: Uint8Array): Promise<void> {
    const device = this.#device;
    const layout = this.#layout;
    if (!device || !layout) throw new Error('No station connected');

    await device.writeCharacteristicWithResponseForService(
      fullUuid(layout.service),
      fullUuid(layout.write),
      toBase64(frame)
    );
  }
}
