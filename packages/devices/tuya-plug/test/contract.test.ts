import { describe, expect, test } from 'bun:test';

import { checkDeviceTypeContract, simulatorContext } from '@kraftverk/device-sdk/testing';

import plug from '../src/type.ts';

describe('the generic Tuya plug', () => {
  test('keeps the device-type contract', async () => {
    expect(await checkDeviceTypeContract(plug, { settleMs: 1_500 })).toEqual([]);
  });

  test('its simulator switches, and remembers where it was left', async () => {
    const { context, stop } = simulatorContext(plug);
    const first = await plug.createSimulator(context);
    expect(await first.capability('switch')!.set(false)).toEqual({ accepted: true });
    await first.close();

    const second = await plug.createSimulator(context);
    expect(second.capability('switch')!.state()?.on).toBe(false);
    expect(second.capability('powerMeter')!.read()?.watts).toBe(0);
    await second.close();
    stop();
  });
});
