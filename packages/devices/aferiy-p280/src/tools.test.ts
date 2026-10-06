import { describe, expect, test } from 'bun:test';

import type { SydpowerLink } from '@kraftverk/integration-sydpower/protocol';

import type { StationClient } from './model/client.ts';
import { registerTools } from './station.ts';
import { STATION_TOOLS } from './tools.ts';

/**
 * The raw-frame tool: the one way to send a frame nobody has described.
 *
 * Spelled out rather than built, so these hold the tool to the frames
 * themselves: AC output on (write holding 26 = 1), and read holding 0+80. The
 * brick write — holding 68 = 0 — is refused whatever else is allowed.
 */

const AC_ON = '1106001a00015d6b';
const READ_SETTINGS = '1103000000506647';
const BRICK = '1106004400000000';

function tools(options: { readOnly: boolean; allowRawFrames: boolean }) {
  const sent: string[] = [];
  const link = {
    address: 'AABBCCDDEEFF',
    transport: 'ble',
    connected: true,
    send: async (frame: Uint8Array) => void sent.push(Buffer.from(frame).toString('hex')),
  } as unknown as SydpowerLink;
  const store = new Map<string, unknown>();
  const raw = registerTools({} as StationClient, link, {
    ...options,
    store: { get: (key) => (store.get(key) ?? null) as never, set: (key, value) => void store.set(key, value), delete: (key) => void store.delete(key) },
  }).raw!;
  return { raw, sent };
}

describe('raw frames', () => {
  test('are off unless the holder was started with them', async () => {
    const { raw, sent } = tools({ readOnly: false, allowRawFrames: false });
    await expect(raw({ hex: READ_SETTINGS })).rejects.toThrow('Raw frames are off');
    expect(sent).toEqual([]);
  });

  test('check read-only themselves: a read is sent, a write is not, however it is spelled', async () => {
    const { raw, sent } = tools({ readOnly: true, allowRawFrames: true });
    expect(STATION_TOOLS.raw.honoursReadOnly).toBe(true);
    // AC output on: 0x06, and the same change as 0x10, 0x16 and 0x17.
    for (const frame of [AC_ON, '1110001a0001020001', '1116001a00000001', '11170000000a001a0001020001']) {
      await expect(raw({ hex: frame })).rejects.toThrow('read-only');
    }
    expect(sent).toEqual([]);

    await raw({ hex: READ_SETTINGS });
    expect(sent).toEqual([READ_SETTINGS]);
  });

  test('with writes allowed, a raw write is sent, and the brick write never is', async () => {
    const { raw, sent } = tools({ readOnly: false, allowRawFrames: true });
    await raw({ hex: AC_ON });
    expect(sent).toEqual([AC_ON]);

    await expect(raw({ hex: BRICK })).rejects.toThrow();
    expect(sent).toEqual([AC_ON]);
  });

  test('refuses what is not whole bytes of hexadecimal', async () => {
    const { raw, sent } = tools({ readOnly: false, allowRawFrames: true });
    for (const hex of ['', 'abc', 'zz']) await expect(raw({ hex })).rejects.toThrow('hex');
    expect(sent).toEqual([]);
  });
});
