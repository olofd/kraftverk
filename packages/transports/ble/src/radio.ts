/*
  The radio beneath the server's Bluetooth transport: what scans, and what
  connects. Two are written — BlueZ over D-Bus (bluez.ts), the stack a Linux
  machine already runs, reached from a container through the system bus with
  no special rights; and noble (noble.ts), which drives the radio itself, for
  a server run on Windows or macOS. The transport above them keeps what does
  not depend on which: the list of what is in range, a channel per device,
  its reconnects, and which GATT layout to use.
*/

/** One advertisement, as either radio hears it. `id` is the device's address, lower case with no colons: `aabbccddeeff`. */
export type Advert = {
  id: string;
  name: string | null;
  rssi: number | null;
  services: string[];
  /** Manufacturer data, as `manufacturerOf` reads it: by company id, hex. */
  manufacturer: Record<string, string>;
};

/** What a connected device has, found once connected. */
export type Gatt = {
  services: string[];
  characteristics: { uuid: string; properties: string[] }[];
};

/** A connection to one device: its GATT database, and its characteristics by UUID. */
export interface Link {
  readonly gatt: Gatt;
  /** Its notifications, from now on. */
  subscribe(uuid: string, listener: (bytes: Uint8Array) => void): Promise<void>;
  write(uuid: string, bytes: Uint8Array, withResponse: boolean): Promise<void>;
  /** Called once, when the device goes. */
  onDisconnect(listener: () => void): void;
  disconnect(): Promise<void>;
}

export interface Radio {
  /** What it is, for the log and the diagnostics: "BlueZ", "noble". */
  readonly name: string;
  /** Starts scanning, every advertisement told. Throws when there is no usable radio. */
  start(onAdvert: (advert: Advert) => void): Promise<void>;
  stop(): Promise<void>;
  /** Whether it can be connected to now: heard, and not forgotten. */
  knows(id: string): boolean;
  /** Connects and finds its GATT database. Not bounded in time: the caller bounds it, and drops what it gave up on. */
  connect(id: string): Promise<Link>;
  /** Lets go of a device a connection was given up on, half made or made. */
  drop(id: string): Promise<void>;
}

/** The manufacturer data of an advertisement, as one company-prefixed blob per company: what `manufacturerOf` reads. */
export function companyBlob(company: number, data: Uint8Array): Uint8Array {
  const blob = new Uint8Array(2 + data.length);
  blob[0] = company & 0xff;
  blob[1] = (company >> 8) & 0xff;
  blob.set(data, 2);
  return blob;
}

/** An address as an id: `AA:BB:CC:DD:EE:FF` → `aabbccddeeff`. */
export const idOfAddress = (address: string): string => address.toLowerCase().replace(/[^0-9a-f]/g, '');
