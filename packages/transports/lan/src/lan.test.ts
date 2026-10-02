import { describe, expect, test } from 'bun:test';
import { createSocket } from 'node:dgram';
import { createServer, type Socket } from 'node:net';

import { memoryTransportStore } from '@kraftverk/device-sdk';

import { hostOf, isLocalAddress } from './index.ts';
import createLanTransport from './system.ts';

/**
 * The home network, for real: a TCP server standing in for a device, and a
 * UDP datagram standing in for its broadcast.
 */

const quiet = { env: {}, log: () => undefined, audit: () => undefined, store: memoryTransportStore() };

const until = async (condition: () => boolean, what: string, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe('the home network', () => {
  test('reaches private addresses only', () => {
    for (const address of ['192.168.1.20', '10.0.0.5', '172.20.1.1', '169.254.3.3', '127.0.0.1', 'plug.local']) {
      expect(isLocalAddress(address)).toBe(true);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', 'example.com', '192.168.1', '300.1.1.1']) {
      expect(isLocalAddress(address)).toBe(false);
    }
  });

  test('a channel connects, carries bytes both ways, comes back after a drop, and starts afresh on reset', async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
      socket.on('data', (data) => socket.write(Buffer.concat([Buffer.from('echo:'), Buffer.from(data)])));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    const transport = createLanTransport(quiet);
    await expect(transport.open('8.8.8.8', { port })).rejects.toThrow('not on the home network');
    const channel = await transport.open('127.0.0.1', { port });
    if (channel.kind !== 'bytes') throw new Error('expected bytes');
    await until(() => channel.connected, 'the connection');

    const received: string[] = [];
    channel.onData((bytes) => received.push(new TextDecoder().decode(bytes)));
    await channel.write(new TextEncoder().encode('hello'));
    await until(() => received.join('') === 'echo:hello', 'the echo');

    // The device drops the connection; the channel says so, and gets it back.
    const states: boolean[] = [];
    channel.onConnectedChange((connected) => states.push(connected));
    sockets[0]!.destroy();
    await until(() => states.includes(false), 'the drop');
    await until(() => channel.connected, 'the reconnect', 6000);

    const before = sockets.length;
    await channel.reset!();
    await until(() => sockets.length > before && channel.connected, 'a fresh connection');

    await channel.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 15_000);

  test('two devices behind one gateway are two addresses on one host: a connection each, to the host', async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => void sockets.push(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    expect(hostOf('192.168.1.20#a4c1380000000001')).toBe('192.168.1.20');
    expect(isLocalAddress('192.168.1.20#a4c1380000000001')).toBe(true);
    expect(isLocalAddress('8.8.8.8#a4c1380000000001')).toBe(false);

    const transport = createLanTransport(quiet);
    const first = await transport.open('127.0.0.1#a4c1380000000001', { port });
    const second = await transport.open('127.0.0.1#a4c1380000000002', { port });
    await until(() => first.connected && second.connected, 'both connections');
    expect(sockets).toHaveLength(2);
    await expect(transport.open('127.0.0.1#a4c1380000000001', { port })).rejects.toThrow('already open');

    await first.close();
    await second.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 15_000);

  test('what devices broadcast is listed while someone watches, and handed over as bytes', async () => {
    const transport = createLanTransport(quiet);
    let seen: readonly { address: string; facts: Record<string, unknown> }[] = [];
    const port = 36000 + Math.floor(Math.random() * 2000);
    const stop = transport.watch!({ udpPorts: [port] }, (sightings) => (seen = sightings));

    const sender = createSocket('udp4');
    await new Promise<void>((resolve) => sender.send(Buffer.from([1, 2, 3, 255]), port, '127.0.0.1', () => resolve()));
    await until(() => seen.length > 0, 'the broadcast');
    expect(seen[0]).toMatchObject({ address: '127.0.0.1', facts: { port, payload: '010203ff' } });

    sender.close();
    stop();
  });
});
