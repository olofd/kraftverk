import { fullUuid, type Announcement, type TransportDefinition } from '@kraftverk/device-sdk';

/**
 * Bluetooth LE: what the transport is, the same everywhere.
 *
 * It runs on the server (noble, when the machine has a radio), in a browser
 * (Web Bluetooth, in Chrome and Edge) and on a phone. Where a method over it is
 * offered follows from which of those have it right now — the device type never
 * says. In a browser there is no scanning: the page may only ask the browser to
 * show its own chooser, from a tap.
 */
const definition: TransportDefinition = {
  id: 'ble',
  label: 'Bluetooth',
  channel: 'bytes',
  // A peripheral is one physical thing.
  exclusive: true,
  nearby: true,
  platforms: ['system', 'web', 'native'],
  discovery: { system: 'list', web: 'chooser', native: 'list' },
  finds: ['advert'],
  // Scanning keeps a radio busy: only while someone looks.
  background: false,
};

export default definition;

/** Bytes as lowercase hex. */
const hex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/**
 * Manufacturer data as an advert carries it: the company id (its first two
 * bytes, little-endian, as a decimal) to the rest, in hex. Empty when there
 * is none, or too little to hold a company id.
 */
export function manufacturerOf(bytes: Uint8Array | null | undefined): Record<string, string> {
  if (!bytes || bytes.length < 2) return {};
  return { [String(bytes[0]! | (bytes[1]! << 8))]: hex(bytes.subarray(2)) };
}

/** An advertisement as a sighting hears it: services in their full form. */
export const advertOf = (name: string | null, services: readonly string[], manufacturer: Readonly<Record<string, string>> = {}): Announcement => ({
  kind: 'advert',
  name,
  services: services.map(fullUuid),
  manufacturer,
});
