import { createSocket, type Socket } from 'node:dgram';

import { aesEcbDecrypt, DISCOVERY_KEY } from './crypto.ts';
import { PREFIX_55AA } from './frame.ts';

/**
 * Finding Tuya devices on the LAN, with no credentials at all.
 *
 * Every Tuya device shouts about itself every few seconds on a UDP broadcast
 * port, encrypted with a key that is identical on every device ever made and
 * therefore public. That means discovery works before you have extracted
 * anything: it hands back the device id, the IP, and — the reason this runs
 * first — **the protocol version**, which decides everything else about how we
 * talk to it.
 *
 * 6666 is the old plaintext port, 6667 the encrypted one, 7000 used by some
 * newer firmware.
 */

export type DiscoveredTuyaDevice = {
  ip: string;
  /** Device id, the same value the Smart Life app calls "Virtual ID". */
  gwId: string;
  version: string;
  productKey?: string;
  /** False when the device has never been paired. */
  active?: boolean;
  /** True when payloads need the local key — everything from 3.3 up. */
  encrypted: boolean;
  seenAt: string;
};

const PORTS = [6666, 6667, 7000];

/** Decodes one broadcast datagram, or null if it is not one of ours. */
export function decodeBroadcast(datagram: Buffer): DiscoveredTuyaDevice | null {
  if (datagram.length < 20 || datagram.readUInt32BE(0) !== PREFIX_55AA) return null;

  const declared = datagram.readUInt32BE(12);
  const body = datagram.subarray(20, Math.min(16 + declared - 8, datagram.length));
  if (body.length === 0) return null;

  const attempts: Buffer[] = [body];
  try {
    attempts.push(aesEcbDecrypt(DISCOVERY_KEY, body));
  } catch {
    /* not encrypted, or not with the public key */
  }

  for (const candidate of attempts) {
    const text = candidate.toString('utf8').replace(/\0+$/, '');
    const start = text.indexOf('{');
    if (start < 0) continue;
    try {
      const json = JSON.parse(text.slice(start)) as Record<string, unknown>;
      if (typeof json.gwId !== 'string' || typeof json.ip !== 'string') continue;
      return {
        ip: json.ip,
        gwId: json.gwId,
        version: typeof json.version === 'string' ? json.version : '3.1',
        productKey: typeof json.productKey === 'string' ? json.productKey : undefined,
        active: typeof json.active === 'number' ? json.active > 0 : undefined,
        encrypted: candidate !== body,
        seenAt: new Date().toISOString(),
      };
    } catch {
      /* try the next decoding */
    }
  }

  return null;
}

/**
 * Listens for broadcasts until `durationMs` elapses.
 *
 * Ports that are already in use are skipped rather than fatal — another Tuya
 * tool on the same machine will hold 6667, and one port is usually enough.
 */
export function scan(durationMs = 12_000): Promise<DiscoveredTuyaDevice[]> {
  const found = new Map<string, DiscoveredTuyaDevice>();
  const sockets: Socket[] = [];

  return new Promise((resolve) => {
    for (const port of PORTS) {
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('message', (datagram) => {
        const device = decodeBroadcast(datagram);
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
