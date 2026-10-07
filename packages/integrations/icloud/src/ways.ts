import type { ConnectionMethod } from '@kraftverk/device-sdk';

import protocol, { ICLOUD_SETUP } from './protocol/index.ts';

/**
 * The way to iCloud: its web API, over HTTPS to Apple's hosts. Held only by
 * a node trusted with an Apple ID's password, and only on a server: Apple's
 * hosts do not answer a browser's page, and a phone's own cookie store gets
 * between its fetch and the session's cookies.
 */
export const ICLOUD_WEB: ConnectionMethod = {
  id: 'icloud',
  label: 'iCloud',
  description: 'Through your Apple ID, as icloud.com is: Find My, the family’s devices included.',
  protocol: protocol.id,
  transport: 'https',
  address: ICLOUD_SETUP,
  reach: 'cloud',
  updates: 'poll',
  platforms: ['system'],
  needs: { trusted: 'your Apple ID’s password stays with the server that signs in with it' },
};

export const ICLOUD_WAYS: readonly ConnectionMethod[] = [ICLOUD_WEB];
