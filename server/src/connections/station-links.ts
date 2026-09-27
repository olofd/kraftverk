import { sameStation, savedDeviceId, stationId, type TransportRuntime } from '@kraftverk/device-sdk';

import type { StationDriver } from '../drivers/types.ts';
import type { ConnectionManager } from './manager.ts';

/**
 * The transports this server lends to device sessions (docs/ARCHITECTURE.md §4).
 *
 * Today that is one thing: the station links the connection manager holds,
 * under `sydpower.station-links`. A station session asks it for its driver by
 * device id — and is told why there is none, when there isn't — and its setup
 * guide asks what the radios can see. When the station's session holds its own
 * links (step 7), this lends the radio and the broker themselves instead.
 */

export const STATION_LINKS = 'sydpower.station-links';

export type StationLinksResource = {
  lookup(deviceId: string): { driver: StationDriver; transport: string } | { driver: null; reason: string | null };
  discovered(): { id: string; name: string; transport: string; bound: boolean }[];
};

export function stationLinks(connections: ConnectionManager): StationLinksResource {
  return {
    lookup(deviceId) {
      const id = savedDeviceId(deviceId);
      const session = connections.get(id);
      return session
        ? { driver: session.driver, transport: session.kind }
        : { driver: null, reason: connections.refusal(id) };
    },
    discovered() {
      return connections.hosts.flatMap(({ kind, host }) =>
        host.discovered().map((station) => ({
          id: station.id,
          name: station.name,
          transport: kind,
          bound: host.openIds().some((open) => sameStation(open, stationId(station.id))),
        }))
      );
    },
  };
}

export function serverTransports(connections: ConnectionManager): TransportRuntime {
  const links = stationLinks(connections);
  return {
    get: <T>(name: string) => (name === STATION_LINKS ? (links as T) : null),
  };
}
