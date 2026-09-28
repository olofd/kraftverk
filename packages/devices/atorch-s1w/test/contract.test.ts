import { describe, expect, test } from 'bun:test';

import { checkDeviceTypeContract, fakeByteChannel, fakeConnection } from '@kraftverk/device-sdk/testing';
import { CMD, encodeFrame, FrameReader } from '@kraftverk/protocol-tuya-local';

import atorch, { ATORCH_S1 } from '../src/type.ts';

/**
 * The ATORCH S1W keeps the device-type contract, and its check step settles the
 * relay question on the unit — the disputed datapoint 1 or 131.
 */

const KEY = '0123456789abcdef';
const bytes = (text: string) => new TextEncoder().encode(text);

/** An ATORCH on protocol 3.3 whose datapoints are `dps`. */
function plug(dps: Record<string, number | boolean>) {
  const key = bytes(KEY);
  const reader = new FrameReader('3.3', key);
  return fakeByteChannel((written) => {
    const out: Uint8Array[] = [];
    for (const frame of reader.push(written)) {
      if (frame.command === CMD.DP_QUERY) {
        out.push(encodeFrame({ version: '3.3', key, sequence: 1, command: CMD.DP_QUERY, payload: bytes(JSON.stringify({ dps })) }));
      }
    }
    return out;
  });
}

const over = (dps: Record<string, number | boolean>) =>
  fakeConnection({
    method: 'lan',
    protocol: 'tuya-local',
    transport: 'lan',
    address: '192.0.2.41',
    channel: plug(dps),
    config: { deviceId: 'bf8dc9aa', protocolVersion: '3.3' },
    secrets: { localKey: KEY },
  });

const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const identify = (dps: Record<string, number | boolean>) =>
  atorch.identify(over(dps), { config: {}, log: quiet, signal: AbortSignal.timeout(10_000) });

describe('the ATORCH S1W', () => {
  test('keeps the device-type contract, and says who it is', async () => {
    const connection = () => over({ '1': true, '19': 152000, '20': 23000 });
    expect(await checkDeviceTypeContract(atorch, { settleMs: 1_500, connections: [connection] })).toEqual([]);
  });

  test('is listed under smart plugs, reached over the home network', () => {
    expect(atorch.meta.category).toBe('smart-plug');
    expect(atorch.connections.map((method) => `${method.protocol}/${method.transport}`)).toEqual(['tuya-local/lan']);
  });

  test('its check reads the plug in engineering units', async () => {
    const found = await identify({ '1': true, '18': 6600, '19': 152000, '20': 23000 });
    expect(found.identity).toBe('tuya-local:bf8dc9aa');
    expect(found.summary).toContain('the relay is on, drawing 1520 W');
    expect(found.config).toBeUndefined();
  });

  test('where the relay is datapoint 131, the check finds it and says so', async () => {
    const found = await identify({ '131': false, '19': 0 });
    expect(found.config).toEqual({ relayDp: 131 });
    expect(found.summary).toContain('Its relay is datapoint 131, not 1');
  });

  test('its layout is the published one', () => {
    expect(ATORCH_S1.metrics.watts).toEqual({ dp: 19, scale: 2 });
    expect(ATORCH_S1.relay.dp).toBe(1);
  });
});
