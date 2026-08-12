import { StationClient, type StationClientOptions } from '@kraftverk/protocol';

import type { StationDriver } from './types.ts';

export { ReadOnlyError } from '@kraftverk/protocol';

/**
 * A real station, reached over MQTT or Bluetooth.
 *
 * Everything this does — the poll loop, the write whitelist, the read-only
 * guard, the decode, the register dumps — lives in `StationClient` in
 * `@kraftverk/protocol`, because the app runs the identical class when it
 * connects to a station directly over Bluetooth instead of through this server.
 *
 * That sharing is the point rather than a saving. A station you can write to
 * should not have two independently maintained ideas of which writes are safe.
 * All that is left here is the `mode` the HTTP layer reports.
 */
export type DeviceDriverOptions = Omit<StationClientOptions, 'model'>;

export class DeviceDriver extends StationClient implements StationDriver {
  readonly mode = 'device' as const;
}
