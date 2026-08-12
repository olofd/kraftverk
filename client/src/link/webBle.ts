import {
  BLE_SERVICE_UUIDS,
  fullUuid,
  isLikelyStation,
  NAME_PREFIXES,
  SERVICE_CANDIDATES,
  type DiscoveredDevice,
} from '@kraftverk/protocol';

import { DirectBleTransport } from './base';

/**
 * A station reached straight from the browser, over Web Bluetooth.
 *
 * No server, no MQTT redirect, no noble: Chrome and Edge talk to the GATT
 * service themselves. The frames, the register map and the write rules are the
 * same ones the server uses — they come from `@kraftverk/protocol` — so a
 * reading taken here and a reading taken through the server are decoded by the
 * identical code.
 *
 * Two browser rules shape the design:
 *
 * 1. **There is no scanning.** A page cannot enumerate nearby devices; it can
 *    only ask the browser to show its own chooser, and it gets back the one the
 *    user picked. So `requestDevice()` is the "scan", and it must be called
 *    straight out of a tap — the permission dies the moment we await anything
 *    else first.
 * 2. **Only a secure context.** `localhost` counts, which is how `npm run dev`
 *    works, but a LAN address opened from another machine needs HTTPS.
 */

// Minimal Web Bluetooth surface. Typed here rather than pulled from
// @types/web-bluetooth so the app takes no dependency for a browser-only path.
type GattCharacteristic = {
  uuid: string;
  startNotifications(): Promise<GattCharacteristic>;
  writeValueWithResponse(value: Uint8Array): Promise<void>;
  addEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
};

type GattService = { uuid: string; getCharacteristic(uuid: string): Promise<GattCharacteristic> };

type GattServer = {
  connected: boolean;
  connect(): Promise<GattServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<GattService>;
};

type BluetoothDevice = {
  id: string;
  name?: string;
  gatt?: GattServer;
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void;
  removeEventListener(type: 'gattserverdisconnected', listener: () => void): void;
};

type RequestOptions = {
  filters?: { services?: string[]; namePrefix?: string; name?: string }[];
  optionalServices?: string[];
  acceptAllDevices?: boolean;
};

type WebBluetooth = {
  getAvailability?(): Promise<boolean>;
  getDevices?(): Promise<BluetoothDevice[]>;
  requestDevice(options: RequestOptions): Promise<BluetoothDevice>;
};

const bluetooth = (): WebBluetooth | null =>
  (globalThis.navigator as unknown as { bluetooth?: WebBluetooth } | undefined)?.bluetooth ?? null;

/** Whether this browser exposes Web Bluetooth at all. */
export const webBluetoothAvailable = (): boolean => bluetooth() !== null;

/**
 * What to do when the browser has it switched off rather than missing.
 *
 * `navigator.bluetooth` still exists in that state, so the object being there
 * proves nothing — the refusal only shows up when the chooser is asked for.
 */
const SWITCHED_OFF =
  'This browser has Web Bluetooth switched off. Brave disables it by default: turn on ' +
  'brave://flags/#brave-web-bluetooth-api. In Chrome or Edge, check ' +
  'chrome://flags/#enable-web-bluetooth, and chrome://policy for a ' +
  'DefaultWebBluetoothGuardSetting your organisation has set. Browsers embedded inside ' +
  'another app usually block it outright — open the app in Chrome or Edge itself. The ' +
  "server's Bluetooth link works regardless: switch Connection to Server and run npm run dev:ble.";

const NO_ADAPTER =
  'No Bluetooth adapter is available to this browser. Check the adapter is present and ' +
  'switched on, then reload.';

/** Why direct Bluetooth is unavailable here, or null when it is fine. */
export function webBluetoothBlockedReason(): string | null {
  if (bluetooth()) return null;
  const secure = (globalThis as { isSecureContext?: boolean }).isSecureContext;
  if (secure === false) {
    return 'Web Bluetooth needs a secure context. Open the app on localhost, or serve it over HTTPS.';
  }
  return 'This browser has no Web Bluetooth. Chrome or Edge on desktop and Android support it; Safari and Firefox do not.';
}

/**
 * Asks the browser whether it would actually serve a chooser, before anyone
 * taps one open.
 *
 * `getAvailability` reports false both when the feature is disabled and when
 * there is no adapter, which is exactly the pair of conditions that otherwise
 * only surface as a thrown DOMException mid-gesture.
 */
export async function webBluetoothUnusableReason(): Promise<string | null> {
  const api = bluetooth();
  if (!api) return webBluetoothBlockedReason();
  if (!api.getAvailability) return null;
  try {
    return (await api.getAvailability()) ? null : SWITCHED_OFF;
  } catch {
    // Older or embedded browsers may not implement it; let the tap decide.
    return null;
  }
}

/** Closing the chooser rejects like a failure. It is a choice, not a fault. */
export class ChooserCancelled extends Error {}

/**
 * Turns a chooser rejection into something worth showing.
 *
 * Chromium reports several very different situations as `NotFoundError`, so the
 * name is not enough to tell "you closed the dialog" from "your browser has
 * this feature turned off" — the message is what carries the meaning.
 */
export function describeRequestFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (/cancell?ed/i.test(message)) return new ChooserCancelled(message);
  if (/globally disabled|permissions? policy|disallowed by/i.test(message)) {
    return new Error(SWITCHED_OFF);
  }
  if (/adapter (is )?not available|no bluetooth adapter|turned off/i.test(message)) {
    return new Error(NO_ADAPTER);
  }
  if (/not supported on this platform/i.test(message)) {
    return new Error(
      'This platform has no Web Bluetooth support in the browser. Use the server link instead.'
    );
  }
  if (/user gesture/i.test(message)) {
    return new Error('The chooser has to open from a tap. Press the button again.');
  }
  return error instanceof Error ? error : new Error(message);
}

export class WebBluetoothTransport extends DirectBleTransport {
  readonly kind = 'direct-web-ble' as const;

  #handles = new Map<string, BluetoothDevice>();
  #boundId: string | null = null;
  #server: GattServer | null = null;
  #writeChar: GattCharacteristic | null = null;
  #notifyChar: GattCharacteristic | null = null;
  #onDisconnected: (() => void) | null = null;
  #onValue = (event: Event) => {
    const value = (event.target as { value?: DataView }).value;
    if (value) this.ingest(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  };

  get boundId(): string | null {
    return this.#boundId;
  }

  get connected(): boolean {
    return this.#server?.connected === true && this.#writeChar !== null;
  }

  /**
   * Re-adopts devices this origin has already been granted, so a reload does
   * not always need another trip through the chooser. Chrome only, and only
   * with its persistent-permissions backend, hence the shrug on failure.
   */
  async start(): Promise<void> {
    const api = bluetooth();
    if (!api?.getDevices) return;
    try {
      for (const device of await api.getDevices()) this.#remember(device);
    } catch {
      /* not supported here; the chooser still works */
    }
  }

  async stop(): Promise<void> {
    await this.unbind();
  }

  /**
   * Opens the browser's device chooser. **Call this directly from a tap** —
   * anything awaited first spends the user gesture and the browser refuses.
   *
   * `showAll` drops the name filter for a station that advertises under a name
   * we do not know, which is likely on a model nobody has tried yet.
   *
   * `onlyNamed` narrows the chooser to a single station by name. There is no
   * way to ask for a device by id — ids are private to the origin and the
   * chooser is the browser's, not ours — but filtering by the remembered name
   * turns "find yours in the list again" into one click on the only row.
   */
  async requestDevice(showAll = false, onlyNamed?: string): Promise<DiscoveredDevice> {
    const api = bluetooth();
    if (!api) throw new Error(webBluetoothBlockedReason() ?? 'Web Bluetooth is unavailable');

    const options: RequestOptions = onlyNamed
      ? { filters: [{ name: onlyNamed }], optionalServices: BLE_SERVICE_UUIDS }
      : showAll
        ? { acceptAllDevices: true, optionalServices: BLE_SERVICE_UUIDS }
        : {
            filters: [
              { services: BLE_SERVICE_UUIDS },
              ...NAME_PREFIXES.map((namePrefix) => ({ namePrefix })),
            ],
            optionalServices: BLE_SERVICE_UUIDS,
          };

    const device = await api
      .requestDevice(options)
      .catch((error: unknown) => {
        // A bare "Web Bluetooth API globally disabled." tells a user nothing
        // about what to do next, and reads like a fault in this app.
        throw describeRequestFailure(error);
      });

    return this.#remember(device);
  }

  #remember(device: BluetoothDevice): DiscoveredDevice {
    const now = new Date().toISOString();
    const name = device.name ?? 'Unnamed Bluetooth device';
    const entry: DiscoveredDevice = {
      id: device.id,
      kind: this.kind,
      name,
      // The browser never reveals a MAC address, by design.
      mac: null,
      firstSeen: now,
      lastSeen: now,
      likelyStation: isLikelyStation({ name: device.name }),
    };

    this.#handles.set(device.id, device);
    this.announce(entry);
    return this.devices.get(device.id) ?? entry;
  }

  async bind(id: string): Promise<void> {
    const device = this.#handles.get(id);
    if (!device) throw new Error('That device is no longer available. Pick it again.');
    if (!device.gatt) throw new Error('This device exposes no GATT server.');

    await this.unbind();
    this.#boundId = id;
    this.assembler.reset();

    const server = await device.gatt.connect();
    this.#server = server;

    const { write, notify } = await this.#openGatt(server);
    this.#writeChar = write;
    this.#notifyChar = notify;

    notify.addEventListener('characteristicvaluechanged', this.#onValue);
    await notify.startNotifications();

    // A station drops the link when it sleeps or goes out of range; reflect
    // that rather than leaving the UI claiming a live connection.
    this.#onDisconnected = () => {
      this.#server = null;
      this.#writeChar = null;
      this.assembler.reset();
    };
    device.addEventListener('gattserverdisconnected', this.#onDisconnected);
  }

  /** Finds the vendor characteristics, trying each documented GATT layout. */
  async #openGatt(server: GattServer): Promise<{ write: GattCharacteristic; notify: GattCharacteristic }> {
    const tried: string[] = [];

    for (const candidate of SERVICE_CANDIDATES) {
      const uuid = fullUuid(candidate.service);
      tried.push(uuid);
      try {
        const service = await server.getPrimaryService(uuid);
        const [write, notify] = await Promise.all([
          service.getCharacteristic(fullUuid(candidate.write)),
          service.getCharacteristic(fullUuid(candidate.notify)),
        ]);
        return { write, notify };
      } catch {
        /* try the next documented layout */
      }
    }

    server.disconnect();
    throw new Error(
      `Connected, but none of the known services answered (${tried.join(', ')}). ` +
        `Close the vendor app if it is holding the station — these units accept one connection at a time.`
    );
  }

  async unbind(): Promise<void> {
    const device = this.#boundId ? this.#handles.get(this.#boundId) : null;

    if (this.#notifyChar) {
      this.#notifyChar.removeEventListener('characteristicvaluechanged', this.#onValue);
    }
    if (device && this.#onDisconnected) {
      device.removeEventListener('gattserverdisconnected', this.#onDisconnected);
    }
    try {
      this.#server?.disconnect();
    } catch {
      /* already gone */
    }

    this.#onDisconnected = null;
    this.#notifyChar = null;
    this.#writeChar = null;
    this.#server = null;
    this.#boundId = null;
    this.assembler.reset();
  }

  protected async writeFrame(frame: Uint8Array): Promise<void> {
    const characteristic = this.#writeChar;
    if (!characteristic) throw new Error('No station connected');
    // Write *with* response: the device ignores writes without one.
    await characteristic.writeValueWithResponse(frame);
  }
}
