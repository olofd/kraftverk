import { describe, expect, test } from 'bun:test';

import { guardChannel, openChannel } from './connection.ts';
import type { Protocol } from './protocol.ts';
import { fakeByteChannel, fakeMessageChannel } from './testing.ts';
import type { Transport } from './transport.ts';

/** Refuses any frame whose first byte is zero, as a protocol's guard would refuse a dangerous write. */
const guarded: Protocol = {
  id: 'test',
  label: 'Test',
  bindings: { bus: { open: () => ({}), recognise: () => null } },
  guard: (payload) => (payload[0] === 0 ? 'Refused: a zero' : null),
};

describe('guardChannel', () => {
  test('a refused frame never reaches a byte channel', async () => {
    const channel = fakeByteChannel(() => null);
    const safe = guardChannel(channel, guarded);
    if (safe.kind !== 'bytes') throw new Error('kind changed');

    await expect(safe.write(new Uint8Array([0, 1]))).rejects.toThrow('Refused: a zero');
    await safe.write(new Uint8Array([1, 2]));
    expect(channel.written.map((bytes) => [...bytes])).toEqual([[1, 2]]);
  });

  test('a refused frame is never published', async () => {
    const channel = fakeMessageChannel(() => []);
    const safe = guardChannel(channel, guarded);
    if (safe.kind !== 'messages') throw new Error('kind changed');

    await expect(safe.publish('cmd', new Uint8Array([0]))).rejects.toThrow('Refused');
    await safe.publish('cmd', new Uint8Array([7]));
    expect(channel.published.map((message) => [...message.payload])).toEqual([[7]]);
  });

  test('everything else is the channel itself, live', () => {
    const channel = fakeByteChannel(() => null);
    const safe = guardChannel(channel, guarded);
    expect(safe.connected).toBe(true);
    channel.setConnected(false);
    expect(safe.connected).toBe(false);
  });

  test('a protocol with no guard gets its channel untouched', () => {
    const channel = fakeByteChannel(() => null);
    expect(guardChannel(channel, { guard: undefined })).toBe(channel);
  });
});

describe('openChannel', () => {
  const bus = (open: Transport['open']): { start: () => Promise<Transport>; available: () => { ok: true } } => ({
    start: async () => ({ open }) as unknown as Transport,
    available: () => ({ ok: true }),
  });

  test('opens through the binding, guarded', async () => {
    const raw = fakeByteChannel(() => null);
    const channel = await openChannel(bus(async () => raw), guarded, { transport: 'bus', address: 'a' });
    if (channel.kind !== 'bytes') throw new Error('kind changed');
    await expect(channel.write(new Uint8Array([0]))).rejects.toThrow('Refused');
    expect(raw.written).toEqual([]);
  });

  test('says why when this holder cannot', async () => {
    await expect(openChannel(bus(async () => fakeByteChannel(() => null)), guarded, { transport: 'radio', address: 'a' })).rejects.toThrow(
      'cannot be reached this way'
    );
    const off = { start: async () => null, available: () => ({ ok: false as const, reason: 'No radio here' }) };
    await expect(openChannel(off, guarded, { transport: 'bus', address: 'a' })).rejects.toThrow('No radio here');
  });
});
