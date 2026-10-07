import type { ConnectionMethod } from '@kraftverk/device-sdk';

import protocol from './protocol/index.ts';

/**
 * Every way a Shelly is reached: its RPC over the home network, with no
 * cloud. It tells of every change as it happens; found by the mDNS service
 * every Gen2-and-later Shelly announces.
 */
export const SHELLY_LAN: ConnectionMethod = {
  id: 'lan',
  label: 'Home network',
  description: 'Straight to the Shelly on your home network, with no cloud. It tells of every change as it happens.',
  protocol: protocol.id,
  transport: 'lan',
  reach: 'local',
  updates: 'push',
  discovery: [{ kind: 'mdns', service: '_shelly._tcp' }],
};

export const SHELLY_WAYS: readonly ConnectionMethod[] = [SHELLY_LAN];
