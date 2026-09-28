import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { savedDeviceId, type CommandResult, type DeviceSession, type WeatherHour } from '@kraftverk/device-sdk';
import type { AuditEntry, CommandIntent, GatewayResult } from '@kraftverk/gateway';

import { closeDb, db } from '../history/db.ts';
import { AutomationEngine, type EngineDevice } from './engine.ts';
import { forecastSwitch, type AutomationRecord } from './recipes.ts';
import { AutomationStore } from './store.ts';
import { dayAfter, localTime, zonedInstant } from './time.ts';

/*
  The engine decides and the gateway acts: these check the deciding, and that
  nothing reaches the gateway unless the automation is armed. The gateway's own
  rules are its own tests' business.
*/

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-automations-'));
beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  db().exec('DELETE FROM automation');
});

const ZONE = 'Europe/Stockholm';
const FORECAST = savedDeviceId('d-forecast');
const PLUG = savedDeviceId('d-plug');

/** A forecast whose every hour has this much cloud, from a day ago to three days ahead. */
function forecastSession(cloud: (at: Date) => number | null, now: Date): DeviceSession {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  const hours: WeatherHour[] = Array.from({ length: 96 }, (_, i) => {
    const at = new Date(start.getTime() + (i - 24) * 3_600_000);
    return { at: at.toISOString(), temperatureC: 10, cloudCoverPercent: cloud(at), precipitationMm: 0, irradianceWm2: null };
  });
  return {
    health: () => ({ status: 'connected', detail: 'Fine', owner: 'server', transport: 'https', lastReadingAt: now.toISOString() }),
    readings: () => [],
    capability: ((name: string) => (name === 'weather.forecast' ? { hourly: (count: number) => hours.filter((hour) => Date.parse(hour.at) >= now.getTime() - 3_600_000).slice(0, count) } : null)) as DeviceSession['capability'],
    close: async () => {},
  };
}

function setup(options: { cloud: (at: Date) => number | null; now: Date; plugRemoved?: boolean; forecastSession?: boolean; plugOutlets?: boolean }) {
  const sent: CommandIntent[] = [];
  const recorded: AuditEntry[] = [];
  const devices: Record<string, EngineDevice> = {
    [FORECAST]: {
      name: 'Weather',
      removed: false,
      session: options.forecastSession === false ? null : forecastSession(options.cloud, options.now),
      offline: 'Not answering',
      capabilities: ['weather.forecast'],
    },
    [PLUG]: { name: 'Heater plug', removed: options.plugRemoved ?? false, session: null, offline: 'n/a', capabilities: options.plugOutlets ? ['outlets', 'battery'] : ['switch', 'powerMeter'] },
  };
  const store = new AutomationStore();
  const engine = new AutomationEngine({
    store,
    device: (id) => devices[id] ?? null,
    gateway: {
      execute: async (intent: CommandIntent): Promise<GatewayResult> => {
        sent.push(intent);
        return { outcome: 'verified', detail: 'Switched on, confirmed by the device', deviceAgreed: true };
      },
    },
    record: (entry) => recorded.push(entry),
    now: () => options.now,
  });
  const make = (params: Record<string, string | number> = {}, mode: AutomationRecord['mode'] = 'observe') => {
    const created = store.create({
      name: 'Sunny heater',
      recipe: 'forecast-switch',
      roles: { forecast: FORECAST, switch: PLUG },
      params: { at: '07:00', day: 'tomorrow', condition: 'sunny', cloudMax: 40, action: 'on', ...params },
      timeZone: ZONE,
    });
    return mode === 'observe' ? created : store.update(created.id, { mode })!;
  };
  return { engine, store, sent, recorded, make };
}

/** 07:05 in Stockholm on a summer day: after the default run time. */
const MORNING = zonedInstant({ year: 2026, month: 6, day: 15, hour: 7, minute: 5 }, ZONE);

describe('time on the owner’s clock', () => {
  test('a Stockholm wall-clock time is found whatever the server’s zone', () => {
    expect(MORNING.toISOString()).toBe('2026-06-15T05:05:00.000Z'); // CEST, UTC+2
    expect(localTime(MORNING, ZONE)).toEqual({ year: 2026, month: 6, day: 15, hour: 7, minute: 5 });
    const winter = zonedInstant({ year: 2026, month: 1, day: 15, hour: 7, minute: 0 }, ZONE);
    expect(winter.toISOString()).toBe('2026-01-15T06:00:00.000Z'); // CET, UTC+1
  });

  test('tomorrow is the owner’s tomorrow, across a month', () => {
    expect(dayAfter(zonedInstant({ year: 2026, month: 6, day: 30, hour: 23, minute: 30 }, ZONE), ZONE, 1)).toEqual({ year: 2026, month: 7, day: 1 });
  });
});

describe('forecast switch', () => {
  test('is due once, at its hour, and not long after', () => {
    const { make } = setup({ cloud: () => 10, now: MORNING });
    const automation = make();
    expect(forecastSwitch.due(automation, MORNING)).toBe(true);
    expect(forecastSwitch.due({ ...automation, lastRunAt: MORNING.toISOString() }, new Date(MORNING.getTime() + 60_000))).toBe(false);
    expect(forecastSwitch.due(automation, zonedInstant({ year: 2026, month: 6, day: 15, hour: 6, minute: 59 }, ZONE))).toBe(false);
    expect(forecastSwitch.due(automation, zonedInstant({ year: 2026, month: 6, day: 15, hour: 9, minute: 0 }, ZONE))).toBe(false);
  });

  test('observing, a sunny tomorrow is what it would have acted on — and nothing is sent', async () => {
    const { engine, make, sent, recorded } = setup({ cloud: () => 15, now: MORNING });
    const result = await engine.run(make());
    expect(result.outcome).toBe('would-act');
    expect(result.summary).toBe('Would turn Heater plug on. Tomorrow looks sunny: 15 % cloud on average between 09:00 and 17:00');
    expect(sent).toEqual([]);
    expect(recorded[0]).toMatchObject({ kind: 'automation.would-act', actor: 'automation:Sunny heater', resource: PLUG });
  });

  test('armed, it acts through the gateway, as an automation, with its reason', async () => {
    const { engine, make, sent } = setup({ cloud: () => 15, now: MORNING });
    const result = await engine.run(make({}, 'armed'));
    expect(result.outcome).toBe('acted');
    expect(sent).toEqual([
      expect.objectContaining({ deviceId: PLUG, capability: 'switch', command: 'set', value: true, actor: 'automation', by: 'automation:Sunny heater' }),
    ]);
    expect(sent[0]!.reason).toContain('Tomorrow looks sunny');
  });

  test('judges tomorrow, not today', async () => {
    // Sunny today and cloudy tomorrow, on the owner's calendar.
    const tomorrow = dayAfter(MORNING, ZONE, 1).day;
    const { engine, make, sent } = setup({ cloud: (at) => (localTime(at, ZONE).day === tomorrow ? 90 : 5), now: MORNING });
    const result = await engine.run(make({}, 'armed'));
    expect(result).toMatchObject({ outcome: 'idle', summary: 'Tomorrow looks cloudy: 90 % cloud on average between 09:00 and 17:00' });
    expect(sent).toEqual([]);
  });

  test('a cloudy condition, and turning off', async () => {
    const { engine, make, sent } = setup({ cloud: () => 80, now: MORNING });
    expect((await engine.run(make({ condition: 'cloudy', action: 'off' }, 'armed'))).outcome).toBe('acted');
    expect(sent[0]).toMatchObject({ value: false });
  });

  test('a forecast with gaps, or none at all, decides nothing', async () => {
    const gappy = setup({ cloud: (at) => (localTime(at, ZONE).hour === 12 ? null : 5), now: MORNING });
    expect(await gappy.engine.run(gappy.make({}, 'armed'))).toMatchObject({ outcome: 'unknown', summary: 'Weather\'s forecast does not cover tomorrow between 09:00 and 17:00' });
    expect(gappy.sent).toEqual([]);

    const silent = setup({ cloud: () => 5, now: MORNING, forecastSession: false });
    expect(await silent.engine.run(silent.make({}, 'armed'))).toMatchObject({ outcome: 'unknown', summary: 'Weather is not answering: Not answering' });
  });

  test('a station fills the switch role through one of its outlets', async () => {
    const { engine, make, sent } = setup({ cloud: () => 5, now: MORNING, plugOutlets: true });
    expect((await engine.run(make({ outlet: 'ac' }, 'armed'))).outcome).toBe('acted');
    expect(sent[0]).toMatchObject({ capability: 'outlets', target: 'ac', value: true });
    // Without saying which outlet, nothing is switched.
    expect((await engine.run(make({}, 'armed'))).outcome).toBe('unknown');
  });

  test('a removed device stops it, and says so', async () => {
    const { engine, make, sent } = setup({ cloud: () => 5, now: MORNING, plugRemoved: true });
    expect(await engine.run(make({}, 'armed'))).toMatchObject({ outcome: 'unknown', summary: 'What to switch: Heater plug has been removed' });
    expect(sent).toEqual([]);
  });

  test('a check decides, but neither acts nor records, even armed', async () => {
    const { engine, make, sent, recorded } = setup({ cloud: () => 5, now: MORNING });
    expect((await engine.run(make({}, 'armed'), { check: true })).outcome).toBe('would-act');
    expect(sent).toEqual([]);
    expect(recorded).toEqual([]);
  });

  test('the engine runs what is due once, keeps the result, and leaves what is off alone', async () => {
    const { engine, make, store, sent } = setup({ cloud: () => 5, now: MORNING });
    const armed = make({}, 'armed');
    const off = make({}, 'off');
    await engine.tick();
    await engine.tick();
    expect(sent).toHaveLength(1);
    expect(store.get(armed.id)!.lastResult).toMatchObject({ outcome: 'acted' });
    expect(store.get(off.id)!.lastRunAt).toBeNull();
  });
});

// Keeps the fake gateway's result type honest against the SDK's.
const _accepted: CommandResult = { accepted: true };
void _accepted;
