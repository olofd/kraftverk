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
  platforms: ['server', 'native'],
  discovery: { server: 'list', native: 'list' },
};

export default definition;

/**
 * Whether an address is on a home network: a private, link-local or loopback
 * IPv4 address, or a local name. This transport reaches nothing else, so a
 * device type cannot use it to reach the internet — that is `https`'s job, and
 * `https` is scoped to one origin.
 */
export function isLocalAddress(address: string): boolean {
  const name = address.trim().toLowerCase();
  if (/\.(local|lan|home\.arpa)$/.test(name)) return true;
  const parts = name.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}
