import type { DeviceSession } from '@kraftverk/device-sdk';

import type { StationDriver } from '../drivers/types.ts';

/**
 * The station driver behind a device session, for the core's remaining
 * station-specific routes — the station dashboard's state, its register tools.
 *
 * Transitional, and deliberately the only place that asks. A station's session
 * offers `station()` beside the device contract; everything generic uses the
 * contract, and these routes move into the station's own package as
 * type-provided routes in step 7 (docs/ARCHITECTURE.md), taking this with them.
 */
export function stationOf(session: DeviceSession | null): StationDriver | null {
  const station = (session as { station?: () => StationDriver | null } | null)?.station;
  return typeof station === 'function' ? station.call(session) : null;
}
