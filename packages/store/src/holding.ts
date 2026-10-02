import type { SavedDeviceId } from '@kraftverk/device-sdk';
import type { SessionManagerDeps } from '@kraftverk/holder';

import type { ConnectionStore } from './connections.ts';

/**
 * A home's connections as one holder holds them, for its session manager:
 * every device's ways in, preferred first; which are this holder's — the
 * server's are those no app holds (`holder` null), an app's its own; their
 * secrets; and the time one last answered.
 */
export function holding(connections: ConnectionStore, holder: string | null): Pick<SessionManagerDeps, 'connections' | 'holds' | 'secret' | 'secretFields' | 'onConnected'> {
  return {
    connections: (deviceId: SavedDeviceId) => connections.forDevice(deviceId),
    holds: (connection) => connection.heldBy === holder,
    secret: (connectionId, field) => connections.secret(connectionId, field),
    secretFields: (connectionId) => connections.secretFields(connectionId),
    onConnected: (connectionId) => connections.touch(connectionId),
  };
}
