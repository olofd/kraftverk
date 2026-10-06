import type { ConnectionMethod } from '@kraftverk/device-sdk';
import sydpower from './protocol/index.ts';

/**
 * Sydpower as a platform: how a power station on its stack is reached,
 * whichever brand sells it. Every one speaks the Sydpower protocol
 * (`./protocol/`) two ways — over Wi-Fi to an MQTT broker,
 * and over Bluetooth — so the ways in are the platform's, and each station's
 * device package is reached by them. A platform names no product.
 */

/** Over Wi-Fi: the station publishes to this home's broker, which it must be set to use. Held while nobody looks. */
export const SYDPOWER_WIFI: ConnectionMethod = {
  id: 'wifi',
  label: 'Wi-Fi',
  description: 'Always on: history and automations keep running. The station must be set to use this server’s broker.',
  protocol: sydpower.id,
  transport: 'mqtt',
  reach: 'local',
  // The station publishes its own figures to the broker, and is asked for the rest.
  updates: 'both',
  recommended: true,
};

/** Over Bluetooth, from whatever holds it within reach: a server's radio, or a phone. */
export const SYDPOWER_BLUETOOTH: ConnectionMethod = {
  id: 'bluetooth',
  label: 'Bluetooth',
  description: 'Within about 10 m of whatever holds it. The station takes one Bluetooth connection at a time.',
  protocol: sydpower.id,
  transport: 'ble',
  reach: 'local',
  updates: 'both',
};

/** Every way a Sydpower station is reached, the one to suggest first. */
export const SYDPOWER_WAYS: readonly ConnectionMethod[] = [SYDPOWER_WIFI, SYDPOWER_BLUETOOTH];
