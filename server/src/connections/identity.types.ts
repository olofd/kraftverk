import { providerDeviceId, savedDeviceId, stationId } from '@kraftverk/plugin-sdk';

import type { ConnectionManager } from './manager.ts';

/**
 * Proof that the identities cannot be swapped.
 *
 * Not a runtime test — there is nothing to run. Every `@ts-expect-error` below
 * fails the build if it *stops* being an error, so weakening `SavedDeviceId`,
 * `StationId` or `ProviderDeviceId` back into plain `string` aliases breaks the
 * typecheck rather than quietly permitting a command to reach the wrong power
 * station.
 *
 * `bind(device, station)` is the signature this exists for: two strings, in an
 * order nobody remembers, where getting it backwards switches somebody else's
 * hardware.
 */

declare const manager: ConnectionManager;

const device = savedDeviceId('power-station:3db445e0');
const station = stationId('AC276E629BEA');
const vendor = providerDeviceId('tuya:bf8dc9aabbcc');

// @ts-expect-error the two arguments of `bind` may not be swapped
manager.bind(station, device);

// @ts-expect-error a station id is not a saved device id
manager.get(station);

// @ts-expect-error a vendor id is not a saved device id either
manager.get(vendor);

// @ts-expect-error and a raw string is neither
manager.get('power-station:3db445e0');

// @ts-expect-error nor may a saved device id stand in for a station
manager.bind(device, device);

/** The right way round, which must keep compiling. */
export const correct = (): Promise<void> => manager.bind(device, station);
