/**
 * Tuya energy sockets as device types. `defineTuyaSocket` builds one from a
 * data layout; this package's own type is the generic socket, and other
 * packages build theirs with it.
 */
export { defineTuyaSocket, type SocketTypeDefinition } from './socket-type.ts';
