import { manufacturerOf } from './index.ts';
import { companyBlob, idOfAddress, type Advert, type Gatt, type Link, type Radio } from './radio.ts';

/*
  Bluetooth LE through BlueZ, over the system D-Bus: the stack a Linux
  machine already runs, owning the radio, so nothing here fights it for the
  adapter. A container reaches it through the host's bus socket, mounted
  (docs/DOCKER.md): no host networking, no capabilities, no native code.

  BlueZ says everything as objects under /org/bluez: the adapter
  (`Adapter1`), each device it has heard (`Device1`), and — once connected —
  its services and characteristics (`GattService1`, `GattCharacteristic1`).
  What changes is told by signals: an object added, a property changed —
  an advertisement's signal and data, a connection made or lost, a
  notification's value.
*/

const BLUEZ = 'org.bluez';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';

/** How long a connection is given to say its services are resolved, once made. */
const RESOLVE_TIMEOUT_MS = 15_000;

/** A signal, as the bus hears it. */
export type Signal = { path: string; iface: string; member: string; body: unknown[] };

/**
 * The system bus, as this needs it: calls, signals and variants. The real
 * one is `systemBus()`; a test hands a BlueZ of its own.
 */
export type BusLike = {
  call(path: string, iface: string, member: string, signature?: string, body?: unknown[]): Promise<unknown>;
  onSignal(listener: (signal: Signal) => void): () => void;
  variant(signature: string, value: unknown): unknown;
  close(): void;
};

/** A variant's value; anything else as it is. */
const unwrap = (value: unknown): unknown =>
  value && typeof value === 'object' && 'signature' in value && 'value' in value ? (value as { value: unknown }).value : value;

type Props = Record<string, unknown>;
const read = (props: Props): Props => Object.fromEntries(Object.entries(props).map(([name, value]) => [name, unwrap(value)]));
const bytesOf = (value: unknown): Uint8Array => (value instanceof Uint8Array ? value : Array.isArray(value) ? new Uint8Array(value as number[]) : new Uint8Array(0));

/** The system bus, through dbus-next: imported only when Bluetooth starts here. */
async function systemBus(): Promise<BusLike> {
  const dbus = (await import('dbus-next')).default;
  const bus = dbus.systemBus();
  const listeners = new Set<(signal: Signal) => void>();
  bus.on('message', (message: { type: number; path: string; interface: string; member: string; body: unknown[] }) => {
    if (message.type !== dbus.MessageType.SIGNAL) return;
    for (const listener of listeners) listener({ path: message.path, iface: message.interface, member: message.member, body: message.body });
  });
  const call = async (path: string, iface: string, member: string, signature?: string, body?: unknown[], destination = BLUEZ) => {
    const reply = await bus.call(new dbus.Message({ destination, path, interface: iface, member, ...(signature ? { signature, body } : {}) }));
    return reply?.body?.length === 1 ? reply.body[0] : reply?.body;
  };
  // BlueZ's signals: objects added and gone, and properties changed — heard by asking the bus for them.
  for (const rule of [`type='signal',sender='${BLUEZ}',interface='${OBJECT_MANAGER}'`, `type='signal',sender='${BLUEZ}',interface='${PROPERTIES}',member='PropertiesChanged'`]) {
    await call('/org/freedesktop/DBus', 'org.freedesktop.DBus', 'AddMatch', 's', [rule], 'org.freedesktop.DBus');
  }
  return {
    call: (path, iface, member, signature, body) => call(path, iface, member, signature, body),
    onSignal: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    variant: (signature, value) => new dbus.Variant(signature, value),
    close: () => bus.disconnect(),
  };
}

/** What BlueZ said of a device, kept as it changes. */
type Device = { path: string; props: Props };

export class BluezRadio implements Radio {
  readonly name = 'BlueZ';
  #bus: BusLike | null = null;
  #adapter: string | null = null;
  #devices = new Map<string, Device>();
  /** By object path: what listens to a characteristic's value, or to a device's connection. */
  #values = new Map<string, (bytes: Uint8Array) => void>();
  #dropped = new Map<string, () => void>();
  #stopSignals: (() => void) | null = null;

  constructor(private bus: () => Promise<BusLike> = systemBus) {}

  async start(onAdvert: (advert: Advert) => void): Promise<void> {
    const bus = await this.bus().catch((error: Error) => {
      throw new Error(`The system bus could not be reached (${error.message}): is /run/dbus mounted?`);
    });
    this.#bus = bus;
    const objects = (await bus.call('/', OBJECT_MANAGER, 'GetManagedObjects')) as Record<string, Record<string, Props>>;
    const adapter = Object.entries(objects).find(([, interfaces]) => interfaces['org.bluez.Adapter1']);
    if (!adapter) throw new Error('BlueZ runs, but has no Bluetooth adapter');
    this.#adapter = adapter[0];
    // An adapter switched off is switched on: Bluetooth is what this transport is for.
    if (unwrap(adapter[1]['org.bluez.Adapter1']!.Powered) !== true) {
      await bus.call(this.#adapter, PROPERTIES, 'Set', 'ssv', ['org.bluez.Adapter1', 'Powered', bus.variant('b', true)]);
    }

    const advertise = (device: Device) => {
      const advert = advertOf(device);
      if (advert) onAdvert(advert);
    };
    for (const [path, interfaces] of Object.entries(objects)) {
      const props = interfaces['org.bluez.Device1'];
      if (props && path.startsWith(`${this.#adapter}/`)) this.#devices.set(path, { path, props: read(props) });
    }
    this.#stopSignals = bus.onSignal((signal) => {
      if (signal.iface === OBJECT_MANAGER && signal.member === 'InterfacesAdded') {
        const [path, interfaces] = signal.body as [string, Record<string, Props>];
        const props = interfaces['org.bluez.Device1'];
        if (!props || !path.startsWith(`${this.#adapter}/`)) return;
        const device = { path, props: read(props) };
        this.#devices.set(path, device);
        advertise(device);
      } else if (signal.iface === OBJECT_MANAGER && signal.member === 'InterfacesRemoved') {
        const [path, removed] = signal.body as [string, string[]];
        if (removed.includes('org.bluez.Device1')) this.#devices.delete(path);
      } else if (signal.iface === PROPERTIES && signal.member === 'PropertiesChanged') {
        const [iface, changed] = signal.body as [string, Props];
        const values = read(changed);
        if (iface === 'org.bluez.Device1') {
          const device = this.#devices.get(signal.path);
          if (!device) return;
          device.props = { ...device.props, ...values };
          if (values.Connected === false) this.#dropped.get(signal.path)?.();
          // What an advertisement changes: its signal, its data, its name.
          if ('RSSI' in values || 'ManufacturerData' in values || 'UUIDs' in values || 'Name' in values) advertise(device);
        } else if (iface === 'org.bluez.GattCharacteristic1' && 'Value' in values) {
          this.#values.get(signal.path)?.(bytesOf(values.Value));
        }
      }
    });

    // Low energy only, every advertisement told — repeated ones keep the signal and "last seen" current.
    await bus.call(this.#adapter, 'org.bluez.Adapter1', 'SetDiscoveryFilter', 'a{sv}', [{ Transport: bus.variant('s', 'le'), DuplicateData: bus.variant('b', true) }]);
    await bus.call(this.#adapter, 'org.bluez.Adapter1', 'StartDiscovery').catch((error: Error) => {
      // Another client has it discovering already: that is as good.
      if (!/InProgress|in progress/i.test(error.message)) throw error;
    });
  }

  async stop(): Promise<void> {
    this.#stopSignals?.();
    if (this.#bus && this.#adapter) await this.#bus.call(this.#adapter, 'org.bluez.Adapter1', 'StopDiscovery').catch(() => undefined);
    this.#bus?.close();
    this.#bus = null;
  }

  #pathOf(id: string): string | null {
    for (const device of this.#devices.values()) if (idOfAddress(String(device.props.Address ?? '')) === id) return device.path;
    return null;
  }

  knows(id: string): boolean {
    return this.#pathOf(id) !== null;
  }

  async connect(id: string): Promise<Link> {
    const bus = this.#bus;
    const path = this.#pathOf(id);
    if (!bus || !path) throw new Error(`${id} is not in range`);
    await bus.call(path, 'org.bluez.Device1', 'Connect');
    await this.#resolved(path);
    const gatt = await this.#gattOf(path);
    const radio = this;
    return {
      gatt: gatt.gatt,
      async subscribe(uuid, listener) {
        const characteristic = gatt.paths.get(uuid);
        if (!characteristic) throw new Error(`${id} has no characteristic ${uuid}`);
        radio.#values.set(characteristic, listener);
        await bus.call(characteristic, 'org.bluez.GattCharacteristic1', 'StartNotify');
      },
      async write(uuid, bytes, withResponse) {
        const characteristic = gatt.paths.get(uuid);
        if (!characteristic) throw new Error(`${id} has no characteristic ${uuid}`);
        await bus.call(characteristic, 'org.bluez.GattCharacteristic1', 'WriteValue', 'aya{sv}', [Buffer.from(bytes), { type: bus.variant('s', withResponse ? 'request' : 'command') }]);
      },
      onDisconnect(listener) {
        radio.#dropped.set(path, () => {
          radio.#dropped.delete(path);
          for (const characteristic of gatt.paths.values()) radio.#values.delete(characteristic);
          listener();
        });
      },
      disconnect: () => this.drop(id),
    };
  }

  async drop(id: string): Promise<void> {
    const path = this.#pathOf(id);
    if (!path || !this.#bus) return;
    this.#dropped.delete(path);
    await this.#bus.call(path, 'org.bluez.Device1', 'Disconnect').catch(() => undefined);
  }

  /** Connected is not yet usable: BlueZ says when it has read the device's services. */
  async #resolved(path: string): Promise<void> {
    const until = Date.now() + RESOLVE_TIMEOUT_MS;
    while (this.#devices.get(path)?.props.ServicesResolved !== true) {
      if (Date.now() > until) throw new Error('Connected, but its services were not resolved in time');
      const resolved = unwrap(await this.#bus!.call(path, PROPERTIES, 'Get', 'ss', ['org.bluez.Device1', 'ServicesResolved']).catch(() => false));
      if (resolved === true) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Its services and characteristics, as BlueZ lists them under it — and each characteristic's object, by UUID. */
  async #gattOf(path: string): Promise<{ gatt: Gatt; paths: Map<string, string> }> {
    const objects = (await this.#bus!.call('/', OBJECT_MANAGER, 'GetManagedObjects')) as Record<string, Record<string, Props>>;
    const services: string[] = [];
    const characteristics: Gatt['characteristics'] = [];
    const paths = new Map<string, string>();
    for (const [object, interfaces] of Object.entries(objects)) {
      if (!object.startsWith(`${path}/`)) continue;
      const service = interfaces['org.bluez.GattService1'];
      if (service) services.push(String(unwrap(service.UUID)));
      const characteristic = interfaces['org.bluez.GattCharacteristic1'];
      if (characteristic) {
        const uuid = String(unwrap(characteristic.UUID));
        characteristics.push({ uuid, properties: (unwrap(characteristic.Flags) as string[] | undefined) ?? [] });
        paths.set(uuid, object);
      }
    }
    return { gatt: { services, characteristics }, paths };
  }
}

/** A device's advertisement, from what BlueZ says of it; null without an address. */
function advertOf(device: Device): Advert | null {
  const { props } = device;
  if (typeof props.Address !== 'string') return null;
  const manufacturer: Record<string, string> = {};
  for (const [company, data] of Object.entries((props.ManufacturerData as Record<string, unknown> | undefined) ?? {})) {
    Object.assign(manufacturer, manufacturerOf(companyBlob(Number(company), bytesOf(unwrap(data)))));
  }
  return {
    id: idOfAddress(props.Address),
    name: typeof props.Name === 'string' ? props.Name : null,
    rssi: typeof props.RSSI === 'number' ? props.RSSI : null,
    services: Array.isArray(props.UUIDs) ? (props.UUIDs as string[]) : [],
    manufacturer,
  };
}
