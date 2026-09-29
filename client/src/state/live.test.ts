import { describe, expect, test } from 'bun:test';

import type { DeviceView, LiveUpdate } from '@kraftverk/api-contract';
import { savedDeviceId } from '@kraftverk/device-sdk';

import { applyLive } from './live';

/*
  The live stream, applied to the list the app keeps: what a card shows moves
  with it, and nothing else does.
*/

const lamp = savedDeviceId('d-lamp');
const plug = savedDeviceId('d-plug');
const at = '2026-09-29T12:00:00.000Z';
const later = '2026-09-29T12:00:05.000Z';

const device = (id: typeof lamp, readings: DeviceView['readings']): DeviceView =>
  ({
    id,
    name: id,
    readings,
    health: { status: 'connected', detail: 'Fine', owner: 'server', transport: 'lan', lastReadingAt: at },
  }) as DeviceView;

describe('applying the live stream', () => {
  const list = [device(lamp, [{ key: 'on', value: true, at }, { key: 'watts', value: 40, at }]), device(plug, [{ key: 'on', value: false, at }])];

  test('a reading replaces the one with its key, and the others stay', () => {
    const next = applyLive(list, [{ type: 'readings', deviceId: lamp, readings: [{ key: 'watts', value: 0, at: later }] }]);
    expect(next[0]!.readings).toEqual([{ key: 'on', value: true, at }, { key: 'watts', value: 0, at: later }]);
    // Untouched devices are the same objects: nothing else redraws.
    expect(next[1]).toBe(list[1]!);
  });

  test('a reading it has never had is added', () => {
    const next = applyLive(list, [{ type: 'readings', deviceId: plug, readings: [{ key: 'watts', value: 3, at: later }] }]);
    expect(next[1]!.readings.map((reading) => reading.key)).toEqual(['on', 'watts']);
  });

  test('health is replaced; a burst is applied in order', () => {
    const offline = { status: 'offline' as const, detail: 'Gone', owner: 'server' as const, transport: 'lan', lastReadingAt: at };
    const updates: LiveUpdate[] = [
      { type: 'readings', deviceId: lamp, readings: [{ key: 'on', value: false, at }] },
      { type: 'readings', deviceId: lamp, readings: [{ key: 'on', value: true, at: later }] },
      { type: 'health', deviceId: lamp, health: offline },
    ];
    const next = applyLive(list, updates);
    expect(next[0]!.readings[0]).toEqual({ key: 'on', value: true, at: later });
    expect(next[0]!.health).toEqual(offline);
  });

  test('what is not for the list changes nothing', () => {
    expect(applyLive(list, [{ type: 'hello', at }, { type: 'changed', deviceId: null }])).toBe(list);
    expect(applyLive(list, [{ type: 'readings', deviceId: savedDeviceId('d-gone'), readings: [{ key: 'on', value: true, at }] }])).toEqual(list);
  });
});
