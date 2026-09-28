import type { ConnectionView, DeviceView } from '@kraftverk/api-contract';

/**
 * The active-connection rule (docs/DATA-MODEL.md §4, decision 12), written
 * once for the server that describes a device and the app that decides what
 * to hold.
 */

/**
 * Which connection is in use: the reachable one highest in the list; with
 * none reachable, the one being tried. Null when nothing is.
 */
export function activeConnection<C extends { id: string; priority: number; reachable: boolean | null }>(connections: readonly C[], trying: string | null): string | null {
  const reachable = [...connections].sort((a, b) => a.priority - b.priority).find((connection) => connection.reachable === true);
  return reachable?.id ?? trying;
}

/** The same connections, with `inUse` set by the rule. */
export function withInUse(connections: readonly ConnectionView[], trying: string | null): ConnectionView[] {
  const inUse = activeConnection(connections, trying ?? connections.find((connection) => connection.inUse)?.id ?? null);
  return connections.map((connection) => ({ ...connection, inUse: connection.id === inUse }));
}

/**
 * Which connection this app should hold for a device, if any: its own
 * connection highest in the list, and only while nothing above it reaches the
 * device. A connection lower down takes over while those above are
 * unreachable, and lets go when one comes back: a station takes one Bluetooth
 * connection at a time, and two holders writing to one device would race.
 */
export function toHold(device: Pick<DeviceView, 'connections'>, clientId: string | null): ConnectionView | null {
  const ordered = [...device.connections].sort((a, b) => a.priority - b.priority);
  for (const connection of ordered) {
    if (connection.heldBy.kind === 'client' && connection.heldBy.id === clientId) return connection;
    if (connection.reachable) return null;
  }
  return null;
}
