import type { SightingFilter, TransportDefinition } from '@kraftverk/device-sdk';

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
};

export default definition;

/**
 * Expands a 16-bit GATT UUID to its full 128-bit form.
 *
 * noble takes the short form, Web Bluetooth and react-native-ble-plx report and
 * expect the long one. Comparing the two forms directly is the classic way to
 * conclude a characteristic is missing when it is right there.
 */
export const fullUuid = (uuid: string): string => {
  const plain = uuid.toLowerCase();
  if (/^[0-9a-f]{4}$/.test(plain)) return `0000${plain}-0000-1000-8000-00805f9b34fb`;
  if (/^[0-9a-f]{32}$/.test(plain)) return `${plain.slice(0, 8)}-${plain.slice(8, 12)}-${plain.slice(12, 16)}-${plain.slice(16, 20)}-${plain.slice(20)}`;
  return plain;
};

/**
 * Whether an advertisement is what a protocol asked to find: one of its
 * services, or a name with one of its prefixes. An empty filter takes
 * everything; a protocol's `recognise` decides after that.
 */
export function matchesFilter(filter: SightingFilter, ad: { name: string | null; services: readonly string[] }): boolean {
  const services = filter.services ?? [];
  const prefixes = filter.namePrefixes ?? [];
  if (!services.length && !prefixes.length) return true;
  const advertised = new Set(ad.services.map(fullUuid));
  if (services.some((service) => advertised.has(fullUuid(service)))) return true;
  const name = ad.name?.toUpperCase() ?? '';
  return prefixes.some((prefix) => name.startsWith(prefix.toUpperCase()));
}
