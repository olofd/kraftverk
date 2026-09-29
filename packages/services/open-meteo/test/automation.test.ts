import { describe, expect, test } from 'bun:test';

import { checkRule, dayAfter, describeRule, localTime, zonedInstant, type DeviceSession } from '@kraftverk/device-sdk';
import type { WeatherHour } from '@kraftverk/protocol-open-meteo';

import { forecastSwitch, skyLooks } from '../src/automation.ts';

/*
  How the sky looks, judged the way the recipe needs it: the owner's day,
  09:00 to 17:00 on their clock, and nothing guessed where the forecast has a
  gap. The engine that runs the recipe is the server's to test.
*/

const ZONE = 'Europe/Stockholm';
/** 07:05 in Stockholm on a summer day. */
const MORNING = zonedInstant({ year: 2026, month: 6, day: 15, hour: 7, minute: 5 }, ZONE);

/** A forecast whose every hour has this much cloud, from a day ago to three days ahead. */
function forecast(cloud: (at: Date) => number | null, now = MORNING): DeviceSession {
  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  const hours: WeatherHour[] = Array.from({ length: 96 }, (_, i) => {
    const at = new Date(start.getTime() + (i - 24) * 3_600_000);
    return { at: at.toISOString(), temperatureC: 10, cloudCoverPercent: cloud(at), precipitationMm: 0, irradianceWm2: null };
  });
  return {
    health: () => ({ status: 'connected', detail: 'Fine', lastReadingAt: now.toISOString() }),
    readings: () => [],
    command: async () => ({ accepted: false, error: 'A forecast takes no commands' }),
    query: async (request) => hours.filter((hour) => Date.parse(hour.at) >= now.getTime() - 3_600_000).slice(0, Number(request.args.hours)),
    close: async () => {},
  };
}

const ask = (session: DeviceSession | null, day: 'today' | 'tomorrow', cloudMax = 40) =>
  skyLooks.evaluate({ part: { name: 'Weather', part: 'main', session, offline: 'Not answering' }, args: { day, cloudMax }, now: MORNING, timeZone: ZONE });

describe('how the sky looks', () => {
  test('sunny by the average between 09:00 and 17:00, with the reason', async () => {
    expect(await ask(forecast(() => 15), 'tomorrow')).toEqual({ value: 'sunny', detail: 'Tomorrow looks sunny: 15 % cloud on average between 09:00 and 17:00' });
    expect(await ask(forecast(() => 55), 'today')).toEqual({ value: 'cloudy', detail: 'Today looks cloudy: 55 % cloud on average between 09:00 and 17:00' });
    expect((await ask(forecast(() => 55), 'today', 60)).value).toBe('sunny');
  });

  test('tomorrow is the owner’s tomorrow, not the server’s', async () => {
    const tomorrow = dayAfter(MORNING, ZONE, 1).day;
    const answer = await ask(forecast((at) => (localTime(at, ZONE).day === tomorrow ? 90 : 5)), 'tomorrow');
    expect(answer).toEqual({ value: 'cloudy', detail: 'Tomorrow looks cloudy: 90 % cloud on average between 09:00 and 17:00' });
  });

  test('a forecast with a gap, or none at all, is not a sunny one: it cannot tell', async () => {
    expect(await ask(forecast((at) => (localTime(at, ZONE).hour === 12 ? null : 5)), 'tomorrow')).toEqual({
      value: null,
      detail: "Weather's forecast does not cover tomorrow between 09:00 and 17:00",
    });
    expect(await ask(null, 'tomorrow')).toEqual({ value: null, detail: 'Weather is not answering: Not answering' });
  });
});

describe('the recipe', () => {
  test('is a rule that checks, and reads as a sentence', () => {
    expect(checkRule(forecastSwitch, { fn: (id) => (id === skyLooks.id ? skyLooks : null) })).toEqual([]);
    const name = (role: string) => (role === 'forecast' ? 'Weather' : 'Heater plug');
    expect(describeRule(forecastSwitch, { at: '07:00', day: 'tomorrow', condition: 'sunny', cloudMax: 40, action: 'on' }, name)).toBe(
      'At 07:00, if tomorrow looks sunny by Weather, turn Heater plug on.'
    );
  });
});
