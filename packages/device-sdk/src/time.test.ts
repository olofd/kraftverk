import { describe, expect, test } from 'bun:test';

import { localTime, zonedInstant, zonedInstants } from './time.ts';

/*
  The owner's clock, in a zone: the instant a clock there shows a time —
  once, twice as clocks go back, or never as they go forward — and where a
  time that does not exist lands.
*/

const iso = (dates: Date[]) => dates.map((date) => date.toISOString());

describe('the instant a clock shows a time', () => {
  test('on an ordinary day, once', () => {
    expect(iso(zonedInstants({ year: 2026, month: 6, day: 15, hour: 7, minute: 0 }, 'Europe/Stockholm'))).toEqual(['2026-06-15T05:00:00.000Z']);
    expect(zonedInstant({ year: 2026, month: 1, day: 15, hour: 7, minute: 0 }, 'Europe/Stockholm').toISOString()).toBe('2026-01-15T06:00:00.000Z');
  });

  test('in the hour repeated as clocks go back, twice — and the first time is the one', () => {
    expect(iso(zonedInstants({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, 'Europe/Stockholm'))).toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
    expect(iso(zonedInstants({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York'))).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
    expect(zonedInstant({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, 'Europe/Stockholm').toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  test('in the hour skipped as clocks go forward, never — and asked anyway, as much later as the clock moved, that same day', () => {
    expect(zonedInstants({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Stockholm')).toEqual([]);
    const spring = zonedInstant({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Stockholm');
    expect(localTime(spring, 'Europe/Stockholm')).toEqual({ year: 2026, month: 3, day: 29, hour: 3, minute: 30 });
    // Where the change is at midnight, midnight is skipped: the day starts at 01:00 — not the evening before.
    const santiago = zonedInstant({ year: 2026, month: 9, day: 6, hour: 0, minute: 0 }, 'America/Santiago');
    expect(localTime(santiago, 'America/Santiago')).toEqual({ year: 2026, month: 9, day: 6, hour: 1, minute: 0 });
    const havana = zonedInstant({ year: 2026, month: 3, day: 8, hour: 0, minute: 30 }, 'America/Havana');
    expect(localTime(havana, 'America/Havana')).toEqual({ year: 2026, month: 3, day: 8, hour: 1, minute: 30 });
  });
});
