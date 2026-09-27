import { describe, expect, test } from 'bun:test';

import { checkDeviceTypeContract, simulatorContext } from '@kraftverk/device-sdk/testing';

import p280 from '../src/type.ts';
import { stationSession, type StationDriverLike } from '../src/station.ts';
import { SimulatedStation } from '../src/simulator.ts';

describe('the P280 device type', () => {
  test('keeps the device-type contract', async () => {
    expect(await checkDeviceTypeContract(p280, { settleMs: 1_500 })).toEqual([]);
  });

  test('its simulator remembers settings in the device’s own store', async () => {
    const { context, stop } = simulatorContext(p280);
    const first = await p280.createSimulator(context);
    await first.writeSettings!({ chargeLimit: 80 });
    await first.close();

    const second = await p280.createSimulator(context);
    expect(second.readSettings!()?.chargeLimit).toBe(80);
    await second.close();
    stop();
  });
});

describe('writing a P280’s settings through its session', () => {
  /** A driver that records what reaches it, so a refusal can be shown to happen first. */
  const recording = () => {
    const station = new SimulatedStation();
    const applied: unknown[] = [];
    const driver: StationDriverLike = {
      status: () => station.status(),
      settings: () => station.settings(),
      setPort: (id, on) => station.setPort(id, on),
      applySettings: async (patch) => {
        applied.push(patch);
        return station.applySettings(patch);
      },
    };
    return { session: stationSession(() => ({ driver, transport: 'sim' })), applied };
  };

  test('a whole-machine sleep time of zero never reaches the station — it destroys it', async () => {
    const { session, applied } = recording();
    await expect(session.writeSettings!({ sleepMinutes: '0' })).rejects.toThrow();
    expect(applied).toEqual([]);
  });

  test('only what was asked for is sent', async () => {
    const { session, applied } = recording();
    await session.writeSettings!({ chargeLimit: 85 });
    expect(applied).toEqual([{ chargeLimit: 85 }]);
  });

  test('a station that is not connected is reported, not invented', () => {
    const session = stationSession(() => ({ driver: null, reason: 'Another saved device is already bound to AA:BB' }));
    expect(session.health()).toMatchObject({ status: 'error', detail: 'Another saved device is already bound to AA:BB' });
    expect(session.readings()).toEqual([]);
    expect(session.capability('battery')!.read()).toBeNull();
    expect(session.readSettings!()).toBeNull();
  });
});
