import type { DirectMethod } from '@kraftverk/device-sdk';

import protocol from './protocol/index.ts';

/**
 * Apple's media devices as a platform. See docs/ADDING-A-DEVICE.md.
 *
 * The one place kraftverk meets an Apple TV — and, as they come, a HomePod
 * (docs/PLAN-INTEGRATIONS.md §8.5): how it is spoken to (`./protocol/`:
 * Companion, with HomeKit's pairing), the ways it is reached and found. It
 * names no product: a device package, built on this, says what an Apple TV
 * does.
 *
 * Ported from pyatv, the library behind Home Assistant's `apple_tv` (NOTICE).
 */

/**
 * Companion over the home network: Apple's own remote's way in, paired once
 * with the PIN the TV shows. It tells of changes as they happen; found by
 * the mDNS service every Apple TV announces.
 */
export const COMPANION_LAN: DirectMethod = {
  id: 'companion',
  label: 'Home network',
  description: 'Straight to the TV on your home network, as Apple’s own remote reaches it, with no cloud. Paired once with the PIN it shows.',
  protocol: protocol.id,
  transport: 'lan',
  reach: 'local',
  updates: 'push',
  discovery: [{ kind: 'mdns', service: '_companion-link._tcp' }],
};
