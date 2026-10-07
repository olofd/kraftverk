import { manufacturerOf } from './index.ts';
import type { Advert, Gatt, Link, Radio } from './radio.ts';

/*
  Bluetooth LE through noble, which drives the radio itself: for a server
  run on Windows or macOS, where there is no BlueZ to ask. Optional, and
  imported only when it is the radio used: a container leaves it out, and a
  Linux machine asks BlueZ instead (bluez.ts).
*/

type Noble = typeof import('@stoprocent/noble').default;
type Peripheral = any;

const short = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
/** 1800/1801 are Generic Access and Generic Attribute — every device has them. */
const onlyGenericServices = (list: { uuid: string }[]) => list.every((service) => ['1800', '1801'].includes(short(service.uuid).replace(/^0000|0000.*$/g, '')));

export class NobleRadio implements Radio {
  readonly name = 'noble';
  #noble: Noble | null = null;
  #peripherals = new Map<string, Peripheral>();

  async start(onAdvert: (advert: Advert) => void): Promise<void> {
    const noble = (await import('@stoprocent/noble')).default;
    this.#noble = noble;
    noble.on('discover', (peripheral: Peripheral) => {
      this.#peripherals.set(peripheral.id, peripheral);
      onAdvert({
        id: peripheral.id,
        name: peripheral.advertisement?.localName || null,
        rssi: typeof peripheral.rssi === 'number' ? peripheral.rssi : null,
        services: peripheral.advertisement?.serviceUuids ?? [],
        manufacturer: peripheral.advertisement?.manufacturerData ? manufacturerOf(new Uint8Array(peripheral.advertisement.manufacturerData)) : {},
      });
    });
    await new Promise<void>((resolve, reject) => {
      if (noble.state === 'poweredOn') return resolve();
      const timer = setTimeout(() => reject(new Error('No Bluetooth radio became available')), 8000);
      noble.once('stateChange', (state: string) => {
        clearTimeout(timer);
        state === 'poweredOn' ? resolve() : reject(new Error(`The Bluetooth radio is ${state}`));
      });
    });
    // allowDuplicates: repeated advertisements are what keep the signal
    // reading and "last seen" current. Without it each device is reported
    // once and its signal freezes at first sighting — useless when you are
    // moving an antenna to improve it.
    await noble.startScanningAsync([], true);
  }

  async stop(): Promise<void> {
    await this.#noble?.stopScanningAsync().catch(() => {});
    this.#noble = null;
  }

  knows(id: string): boolean {
    return this.#peripherals.has(id);
  }

  async connect(id: string): Promise<Link> {
    const peripheral = this.#peripherals.get(id);
    if (!peripheral) throw new Error(`${id} is not in range`);
    await peripheral.connectAsync();
    let { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
    // Windows sometimes returns a partial GATT database on the first pass, and
    // for an unpaired peripheral it returns only 1800/1801 permanently (WinRT
    // hides custom services until the device is bonded). A retry costs little
    // and fixes the transient case; the permanent case is reported above it.
    if (services.length === 0 || onlyGenericServices(services)) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const retry = await peripheral.discoverAllServicesAndCharacteristicsAsync();
      if (retry.services.length > services.length) ({ services, characteristics } = retry);
    }
    const gatt: Gatt = {
      services: services.map((service: any) => service.uuid),
      characteristics: characteristics.map((characteristic: any) => ({ uuid: characteristic.uuid, properties: characteristic.properties ?? [] })),
    };
    const byUuid = (uuid: string) => characteristics.find((characteristic: any) => characteristic.uuid === uuid);
    return {
      gatt,
      async subscribe(uuid, listener) {
        const characteristic = byUuid(uuid);
        characteristic.removeAllListeners('data');
        characteristic.on('data', (data: Buffer) => listener(new Uint8Array(data)));
        await characteristic.subscribeAsync();
      },
      // noble's second argument is "without response".
      write: async (uuid, bytes, withResponse) => byUuid(uuid).writeAsync(Buffer.from(bytes), !withResponse),
      onDisconnect(listener) {
        peripheral.removeAllListeners('disconnect');
        peripheral.once('disconnect', listener);
      },
      disconnect: () => peripheral.disconnectAsync().catch(() => {}),
    };
  }

  async drop(id: string): Promise<void> {
    await this.#peripherals.get(id)?.disconnectAsync().catch(() => {});
  }
}
