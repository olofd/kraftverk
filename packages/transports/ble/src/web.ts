import type { Availability, ByteChannel, OpenOptions, Sighting, SightingFilter, Transport, TransportContext, TransportFactory } from '@kraftverk/device-sdk';

import definition, { fullUuid } from './index.ts';

/**
 * Bluetooth LE from a browser: Web Bluetooth, in Chrome and Edge.
 *
 * Two browser rules shape it:
 *
 * 1. **There is no scanning.** A page cannot list nearby devices; it can only
 *    ask the browser to show its own chooser, and gets back the one picked.
 *    So finding a device is `choose`, and it must be called straight from a
 *    tap — the permission is spent the moment anything else is awaited first.
 * 2. **No MAC, ever.** The browser hands out a private id per origin instead.
 *    That id is the address a connection held by this browser is saved with,
 *    and it means nothing anywhere else.
 *
 * A device chosen once is remembered by the browser (Chrome's persistent
 * permissions), so a reload reconnects without the chooser when it can. When
 * it cannot, the channel says so, and choosing it again is one tap.
 */

// The Web Bluetooth surface used here. Typed locally so nothing depends on
// @types/web-bluetooth for a browser-only path.
type GattCharacteristic = {
  startNotifications(): Promise<GattCharacteristic>;
  writeValueWithResponse(value: Uint8Array): Promise<void>;
  writeValueWithoutResponse?(value: Uint8Array): Promise<void>;
  addEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void;
};
type GattService = { getCharacteristic(uuid: string): Promise<GattCharacteristic> };
type GattServer = { connected: boolean; connect(): Promise<GattServer>; disconnect(): void; getPrimaryService(uuid: string): Promise<GattService> };
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

const bluetooth = (): WebBluetooth | null => (globalThis.navigator as unknown as { bluetooth?: WebBluetooth } | undefined)?.bluetooth ?? null;

const SWITCHED_OFF =
  'This browser has Web Bluetooth switched off. Brave disables it by default: turn on ' +
  'brave://flags/#brave-web-bluetooth-api. In Chrome or Edge, check chrome://flags/#enable-web-bluetooth, ' +
  'and chrome://policy for a DefaultWebBluetoothGuardSetting your organisation has set. A browser embedded ' +
  'in another app usually blocks it: open the app in Chrome or Edge itself.';

const NO_ADAPTER = 'No Bluetooth adapter is available to this browser. Check it is present and switched on, then reload.';

/** Why Web Bluetooth cannot be used here, or null when it can. */
export function blockedReason(): string | null {
  if (bluetooth()) return null;
  if ((globalThis as { isSecureContext?: boolean }).isSecureContext === false) {
    return 'Web Bluetooth needs a secure context: open the app on localhost, or over HTTPS.';
  }
  return 'This browser has no Web Bluetooth. Chrome and Edge have it, on desktop and Android; Safari and Firefox do not.';
}

/**
 * A chooser rejection, in words. Chromium reports very different situations
 * as `NotFoundError`; only the message tells "you closed it" from "it is off".
 */
function describeFailure(error: unknown): Error | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancell?ed/i.test(message)) return null;
  if (/globally disabled|permissions? policy|disallowed by/i.test(message)) return new Error(SWITCHED_OFF);
  if (/adapter (is )?not available|no bluetooth adapter|turned off/i.test(message)) return new Error(NO_ADAPTER);
  if (/user gesture/i.test(message)) return new Error('The chooser has to open from a tap. Press the button again.');
  return error instanceof Error ? error : new Error(message);
}

class WebBleChannel implements ByteChannel {
  readonly kind = 'bytes' as const;
  #server: GattServer | null = null;
  #write: GattCharacteristic | null = null;
  #notify: GattCharacteristic | null = null;
  #connected = false;
  #closed = false;
  #connecting: Promise<void> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #backoffMs = 2000;
  #lastError: string | null = null;
  #data = new Set<(bytes: Uint8Array) => void>();
  #state = new Set<(connected: boolean) => void>();

  #onValue = (event: Event) => {
    const value = (event.target as { value?: DataView }).value;
    if (!value) return;
    const bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    for (const listener of [...this.#data]) listener(bytes);
  };
  #onDisconnected = () => {
    this.#setConnected(false);
    this.#schedule();
  };

  constructor(
    readonly address: string,
    private device: () => BluetoothDevice | null,
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
    const characteristic = this.#write;
    if (!characteristic || !this.#connected) throw new Error('Not connected over Bluetooth');
    if (this.options.writeWithResponse === false && characteristic.writeValueWithoutResponse) await characteristic.writeValueWithoutResponse(bytes);
    else await characteristic.writeValueWithResponse(bytes);
  }

  /** Starts again from nothing: what a protocol asks for after a garbled exchange. */
  async reset(): Promise<void> {
    this.#teardown();
    this.#setConnected(false);
    await this.#connect();
  }

  describe(): Record<string, unknown> {
    return { address: this.address, connected: this.#connected, lastError: this.#lastError, known: this.device() !== null };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#teardown();
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
      const device = this.device();
      try {
        if (this.#closed) return;
        // Not granted to this page yet: choosing it again, from a tap, is how.
        if (!device?.gatt) throw new Error('This browser has to be shown the device again: choose it once more');
        const server = await device.gatt.connect();
        const { write, notify } = await this.#openGatt(server);
        if (this.#closed) {
          server.disconnect();
          return;
        }
        this.#server = server;
        this.#write = write;
        this.#notify = notify;
        notify.addEventListener('characteristicvaluechanged', this.#onValue);
        await notify.startNotifications();
        device.addEventListener('gattserverdisconnected', this.#onDisconnected);
        this.#backoffMs = 2000;
        this.#lastError = null;
        this.#setConnected(true);
      } catch (error) {
        this.#lastError = (error as Error).message;
        this.log('warn', `[ble] ${this.address}: ${this.#lastError}`);
        this.#teardown();
        // A device the page cannot reach without a tap is not retried in a loop.
        if (device?.gatt) this.#schedule();
      } finally {
        this.#connecting = null;
      }
    })();
    return this.#connecting;
  }

  /** The first GATT layout the protocol asked for that the device has. */
  async #openGatt(server: GattServer): Promise<{ write: GattCharacteristic; notify: GattCharacteristic }> {
    const tried: string[] = [];
    for (const layout of this.options.gatt ?? []) {
      tried.push(fullUuid(layout.service));
      try {
        const service = await server.getPrimaryService(fullUuid(layout.service));
        const [write, notify] = await Promise.all([service.getCharacteristic(fullUuid(layout.write)), service.getCharacteristic(fullUuid(layout.notify))]);
        return { write, notify };
      } catch {
        // the next layout
      }
    }
    server.disconnect();
    throw new Error(
      `Connected, but none of the expected services answered (${tried.join(', ') || 'none asked for'}). ` +
        'Close any other app holding the device: it may take one connection at a time.'
    );
  }

  #teardown(): void {
    this.#notify?.removeEventListener('characteristicvaluechanged', this.#onValue);
    this.device()?.removeEventListener('gattserverdisconnected', this.#onDisconnected);
    try {
      this.#server?.disconnect();
    } catch {
      // already gone
    }
    this.#server = null;
    this.#write = null;
    this.#notify = null;
  }
}

const createWebBleTransport: TransportFactory = (context: TransportContext): Transport => {
  const handles = new Map<string, BluetoothDevice>();
  let unusable: string | null = null;

  const remember = (device: BluetoothDevice): Sighting => {
    handles.set(device.id, device);
    return { transport: 'ble', address: device.id, name: device.name ?? undefined, seenAt: new Date().toISOString(), facts: {} };
  };

  return {
    definition,

    available(): Availability {
      const reason = blockedReason() ?? unusable;
      return reason ? { ok: false, reason } : { ok: true };
    },

    async start() {
      const api = bluetooth();
      if (!api) return;
      // Asked now, so the add screen can say "switched off" before anyone taps a chooser open.
      try {
        if (api.getAvailability && !(await api.getAvailability())) unusable = SWITCHED_OFF;
      } catch {
        // older browsers: let the tap decide
      }
      // Devices this page was granted before: reconnecting to them needs no chooser.
      try {
        for (const device of (await api.getDevices?.()) ?? []) remember(device);
      } catch {
        // not supported here; the chooser still works
      }
    },

    async stop() {
      handles.clear();
    },

    /**
     * The browser's chooser. **Call it straight from a tap.** An empty filter
     * shows every device, for one that advertises under a name nobody knows.
     */
    async choose(filter: SightingFilter): Promise<Sighting | null> {
      const api = bluetooth();
      if (!api) throw new Error(blockedReason() ?? 'Web Bluetooth is unavailable');
      const services = (filter.services ?? []).map(fullUuid);
      const prefixes = filter.namePrefixes ?? [];
      const options: RequestOptions =
        services.length || prefixes.length
          ? { filters: [...services.map((service) => ({ services: [service] })), ...prefixes.map((namePrefix) => ({ namePrefix }))], optionalServices: services }
          : { acceptAllDevices: true, optionalServices: services };
      try {
        const sighting = remember(await api.requestDevice(options));
        // It passed the protocol's own filter: that is the evidence recognition has.
        return { ...sighting, facts: { services: filter.services ?? [], chosen: true } };
      } catch (error) {
        const failure = describeFailure(error);
        if (!failure) return null;
        throw failure;
      }
    },

    async open(address: string, options: OpenOptions) {
      return new WebBleChannel(address, () => handles.get(address) ?? null, options, context.log);
    },
  };
};

export default createWebBleTransport;
