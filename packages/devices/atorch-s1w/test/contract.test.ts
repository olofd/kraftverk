import { describe, expect, test } from 'bun:test';

import { checkDeviceTypeContract, fakeByteChannel, fakeConnection } from '@kraftverk/device-sdk/testing';
import { CMD, encodeFrame, FrameReader } from '@kraftverk/integration-tuya/protocol';

import atorch, { ATORCH_S1 } from '../src/type.ts';

/**
 * The ATORCH keeps the device-type contract, and reads and switches the way the
 * real unit does (README.md): the relay on DP 131 in words, DP 1 only a report.
 */

const KEY = '0123456789abcdef';
const bytes = (text: string) => new TextEncoder().encode(text);

type Dps = Record<string, number | boolean | string>;

/** An ATORCH on protocol 3.3 whose datapoints are `dps`, keeping what it is sent. */
function plug(dps: Dps) {
  const key = bytes(KEY);
  const reader = new FrameReader('3.3', key);
  const sent: Dps[] = [];
  const channel = fakeByteChannel((written) => {
    const out: Uint8Array[] = [];
    for (const frame of reader.push(written)) {
      if (frame.command === CMD.CONTROL) {
        const control = JSON.parse(new TextDecoder().decode(frame.payload)) as { dps: Dps };
        sent.push(control.dps);
        Object.assign(dps, control.dps);
        out.push(encodeFrame({ version: '3.3', key, sequence: 1, command: CMD.CONTROL, payload: bytes('') }));
      }
      if (frame.command === CMD.DP_QUERY) {
        out.push(encodeFrame({ version: '3.3', key, sequence: 1, command: CMD.DP_QUERY, payload: bytes(JSON.stringify({ dps })) }));
      }
    }
    return out;
  });
  return { channel, sent };
}

const over = (channel: ReturnType<typeof plug>['channel']) =>
  fakeConnection({
    method: 'lan',
    protocol: 'tuya-local',
    transport: 'lan',
    address: '192.0.2.41',
    channel,
    config: { deviceId: 'bf8dc9aa', protocolVersion: '3.3' },
    secrets: { localKey: KEY },
  });

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/** A real session over a scripted plug, the way a holder opens one. */
async function session(dps: Dps) {
  const device = plug(dps);
  const events: { id: string; data: unknown }[] = [];
  const opened = await atorch.createSession({
    config: { profile: ATORCH_S1.id, pollSeconds: 60 },
    connection: over(device.channel),
    log: quiet,
    readOnly: false,
    store: { get: () => undefined, set: () => {}, delete: () => {} },
    schedule: () => {},
    changed: () => {},
    event: (id: string, data: unknown) => events.push({ id, data }),
  } as never);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const value = (key: string) => opened.readings().find((reading) => reading.key === key)?.value;
  return { device, opened, value, events };
}

describe('the ATORCH S1W', () => {
  test('keeps the device-type contract, and says who it is', async () => {
    const connection = () => over(plug({ '131': 'open', '1': true, '19': 152000, '20': 23000, '140': false }).channel);
    expect(await checkDeviceTypeContract(atorch, { settleMs: 1_500, connections: [connection] })).toEqual([]);
  });

  test('is listed under smart plugs, reached over the home network', () => {
    expect(atorch.meta.category).toBe('smart-plug');
    expect(atorch.connections.map((method) => `${method.protocol}/${method.transport}`)).toEqual(['tuya-local/lan']);
  });

  test('its check reads the plug in engineering units, the relay from DP 131', async () => {
    const found = await atorch.identify(over(plug({ '131': 'open', '1': false, '18': 6600, '19': 152000, '20': 23000 }).channel), {
      config: {},
      log: quiet,
      signal: AbortSignal.timeout(10_000),
    });
    expect(found.identity).toBe('tuya-local:bf8dc9aa');
    expect(found.summary).toContain('the relay is on, drawing 1520 W');
  });

  test('switches on DP 131 in words, never on DP 1', async () => {
    const { device, opened, value } = await session({ '131': 'open', '1': true });
    expect(await opened.command({ part: 'main', capability: 'switch', command: 'set', args: { on: false } })).toEqual({ accepted: true });
    expect(device.sent).toEqual([{ '131': 'close' }]);
    expect(value('relay')).toBe(false);
    await opened.close();
  });

  test('reads energy in thousandths of a kWh, and its own settings through their wire words', async () => {
    const { value } = await session({ '131': 'open', '123': 19595, '138': 'colse', '117': 'calendar', '104': 2577, '118': 'wifi1' });
    expect(value('kwh')).toBe(19.595);
    expect(value('afterPowerCut')).toBe('off');
    expect(value('dimmedShows')).toBe('nothing');
    expect(value('maxVoltage')).toBe(257.7);
    // Its screen's protection page runs no rule, any more than the price page does.
    expect(value('rule')).toBe('none');
  });

  test('offers as settings only what a person decides: the power cut, the safety cut-off, the display', () => {
    const attributes = atorch.describe({ profile: ATORCH_S1.id, pollSeconds: 10 }).attributes;
    const settings = attributes.filter((attribute) => attribute.category === 'config');
    expect([...new Set(settings.map((attribute) => attribute.section))]).toEqual(['Power', 'Safety cut-off', 'Display', 'Bill']);
    // Written by the screens, never offered: live readings while someone watches, and clearing the plug's own rule.
    expect(attributes.filter((attribute) => attribute.access === 'write' && attribute.category !== 'config').map((attribute) => attribute.key)).toEqual(['rule', 'live']);
  });

  test('writes a setting as the plug spells it, and answers with what it reports afterwards', async () => {
    const { device, opened } = await session({ '131': 'open', '138': 'memory' });
    expect(await opened.write!({ afterPowerCut: 'off' })).toEqual({ afterPowerCut: 'off' });
    expect(device.sent).toEqual([{ '138': 'colse' }]);
    await opened.close();
  });

  test('a cut by the plug itself, pushed unasked, reads as off and is an event naming why', async () => {
    const { device, value, events, opened } = await session({ '131': 'auto', '1': true, '132': 'off' });
    expect(value('relay')).toBe(true);
    // As the unit did: Smart power off A fires, and DP 1 is not pushed.
    device.channel.push(encodeFrame({ version: '3.3', key: bytes(KEY), sequence: 9, command: CMD.STATUS, payload: bytes(JSON.stringify({ dps: { '132': 'outage_a' } })) }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(value('relay')).toBe(false);
    expect(value('cutBy')).toBe('lowPower');
    expect(events).toEqual([{ id: 'cut', data: { reason: 'lowPower' } }]);
    await opened.close();
  });

  test('live readings are one wish: on until a time, off at once, and nobody turns them back on', async () => {
    const { device, opened, value } = await session({ '131': 'open', '140': false });
    expect(await opened.write!({ live: true })).toEqual({ live: true });
    expect(device.sent.at(-1)).toEqual({ '140': true });
    expect(Date.parse(String(value('liveUntil')))).toBeGreaterThan(Date.now() + 10 * 60_000);

    // The plug lets it lapse, and says so: wanted, it is turned back on at once.
    device.channel.push(encodeFrame({ version: '3.3', key: bytes(KEY), sequence: 9, command: CMD.STATUS, payload: bytes(JSON.stringify({ dps: { '140': false } })) }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(device.sent.at(-1)).toEqual({ '140': true });

    // Switched off: off at once, and a lapse after that is left alone.
    expect(await opened.write!({ live: false })).toEqual({ live: false });
    expect(device.sent.at(-1)).toEqual({ '140': false });
    const sent = device.sent.length;
    device.channel.push(encodeFrame({ version: '3.3', key: bytes(KEY), sequence: 10, command: CMD.STATUS, payload: bytes(JSON.stringify({ dps: { '140': false } })) }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(device.sent.length).toBe(sent);
    expect(value('live')).toBe(false);
    await opened.close();
  });

  test('its buttons are tools that press once: the screen turned, the counter zeroed after asking', async () => {
    const { device, opened } = await session({ '131': 'open' });
    expect(await opened.tools!.rotateScreen!({})).toBe(true);
    expect(device.sent.at(-1)).toEqual({ '116': true });
    expect(atorch.tools?.resetEnergy?.confirm).toContain('cannot be brought back');
    await opened.close();
  });

  test('its layout is the one established on the unit', () => {
    expect(ATORCH_S1.relay).toEqual({ dp: 131, on: 'open', off: 'close', status: 1, cutWhile: { dp: 132, clear: 'off' } });
    expect(ATORCH_S1.metrics.kwh).toEqual({ dp: 123, scale: 3 });
    expect(ATORCH_S1.metrics.watts).toEqual({ dp: 19, scale: 2 });
  });
});
