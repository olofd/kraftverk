import { createSocket, type Socket } from 'node:dgram';

import { decodeBroadcast, DISCOVERY_PORTS, type DiscoveredTuyaDevice } from '../src/protocol/discovery.ts';

/**
 * Listens for Tuya broadcasts for a while, for the command-line tools.
 *
 * Ports already in use are skipped rather than fatal — another Tuya tool on the
 * same machine holds 6667, and one port is usually enough.
 */
export function listen(durationMs: number): Promise<DiscoveredTuyaDevice[]> {
  const found = new Map<string, DiscoveredTuyaDevice>();
  const sockets: Socket[] = [];
  return new Promise((resolve) => {
    for (const port of DISCOVERY_PORTS) {
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('message', (datagram) => {
        const device = decodeBroadcast(new Uint8Array(datagram));
        if (device) found.set(device.gwId, { ...found.get(device.gwId), ...device });
      });
      socket.on('error', () => socket.close());
      try {
        socket.bind(port);
        sockets.push(socket);
      } catch {
        /* port unavailable; the others may still work */
      }
    }
    setTimeout(() => {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
      }
      resolve([...found.values()]);
    }, durationMs);
  });
}
