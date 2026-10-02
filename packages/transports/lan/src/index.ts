import type { TransportDefinition } from '@kraftverk/device-sdk';

/**
 * The home network: TCP to a device, and UDP broadcasts to find one. What the
 * transport is, the same everywhere.
 *
 * On the server, and — later — in the phone app, which can open sockets. Not in
 * a browser: a page may not open a raw socket, which is why a method over this
 * transport is never offered there.
 */
const definition: TransportDefinition = {
  id: 'lan',
  label: 'the home network',
  channel: 'bytes',
  // An address on the home network is one device.
  exclusive: true,
  nearby: false,
  platforms: ['system', 'native'],
  discovery: { system: 'list', native: 'list' },
};

export default definition;

/**
 * The host an address is reached at. An address is a host — an IP address, a
 * local name — or, for a device behind a gateway on it (a Zigbee plug behind
 * its gateway), the host, `#`, and what the gateway knows the device by:
 * `192.168.1.20#a4c1380000000001`. The transport connects to the host; the
 * whole address is the one device, so two devices behind one gateway are two
 * addresses, each claimed by its own device, each with its own connection.
 */
export const hostOf = (address: string): string => address.split('#')[0]!.trim();

/**
 * Whether an address is on a home network: a private, link-local or loopback
 * IPv4 address, or a local name. This transport reaches nothing else, so a
 * device type cannot use it to reach the internet — that is `https`'s job, and
 * `https` is scoped to one origin.
 */
export function isLocalAddress(address: string): boolean {
  const name = hostOf(address).toLowerCase();
  if (/\.(local|lan|home\.arpa)$/.test(name)) return true;
  const parts = name.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
