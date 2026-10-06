import type { NodeId, SavedDeviceId } from '@kraftverk/device-sdk';
import type { SessionManagerDeps } from '@kraftverk/holder';

import type { ConnectionStore } from './connections.ts';

/**
 * A home's connections as one node holds them, for its session manager:
 * every device's ways in, preferred first; which are this node's — those it
 * holds (`held_by`), whichever node of the home it is; their secrets; and
 * the time one last answered.
 */
export function holding(connections: ConnectionStore, holder: NodeId): Pick<SessionManagerDeps, 'connections' | 'holds' | 'secret' | 'secretFields' | 'keepSecret' | 'onConnected'> {
  return {
    connections: (deviceId: SavedDeviceId) => connections.forDevice(deviceId),
    holds: (connection) => connection.heldBy === holder,
    secret: (connectionId, field) => connections.secret(connectionId, field),
    // What a person gave: what its session keeps changes as it runs, and reopens nothing.
    secretFields: (connectionId) => connections.secretFields(connectionId, 'person'),
    keepSecret: (connectionId, field, value) => (value === null ? connections.forgetSecret(connectionId, field) : connections.setSecrets(connectionId, { [field]: value }, 'session')),
    onConnected: (connectionId) => connections.touch(connectionId),
  };
}
