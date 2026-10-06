import { describe, expect, test } from 'bun:test';

import { zonedInstant } from '@kraftverk/device-sdk';
import { parsePrices, pricesPath, PRICE_TIME_ZONE, type PricePeriod } from '../src/protocol/index.ts';

import { hoursIn, periodAt, rankAt, simulatedDay } from '../src/prices.ts';

/*
  The prices of a day, read and ranked: the price of the quarter hour now,
  and where its hour stands among the day's hours — on the Swedish clock,
  whatever the market's resolution, and not at all on a day known only in
  part.
*/

const at = (day: number, hour: number, minute = 0) => zonedInstant({ year: 2026, month: 9, day, hour, minute }, PRICE_TIME_ZONE).getTime();

/** A day of quarter hours whose hour's price is its place in \`order\`: hour h costs order[h]. */
const day = (dayOfMonth: number, order: readonly number[]): PricePeriod[] =>
  order.flatMap((price, hour) =>
    [0, 15, 30, 45].map((minute) => {
      const from = at(dayOfMonth, hour, minute);
      return { from: new Date(from).toISOString(), to: new Date(from + 15 * 60_000).toISOString(), price };
    })
  );

describe('reading the API', () => {
  test('asks for a day in an area, and reads the currency asked for — leaving out anything malformed', () => {
    expect(pricesPath({ year: 2026, month: 9, day: 3 }, 'SE3')).toBe('/api/v1/prices/2026/09-03_SE3.json');
    const answer = [
      { SEK_per_kWh: 0.8884, EUR_per_kWh: 0.07845, EXR: 11.3, time_start: '2026-09-30T00:15:00+02:00', time_end: '2026-09-30T00:30:00+02:00' },
      { SEK_per_kWh: 0.9, EUR_per_kWh: 0.08, EXR: 11.3, time_start: '2026-09-30T00:00:00+02:00', time_end: '2026-09-30T00:15:00+02:00' },
      { SEK_per_kWh: 'soon', time_start: '2026-09-30T00:30:00+02:00', time_end: '2026-09-30T00:45:00+02:00' },
    ];
    expect(parsePrices(answer, 'SEK')).toEqual([
      { from: '2026-09-29T22:00:00.000Z', to: '2026-09-29T22:15:00.000Z', price: 0.9 },
      { from: '2026-09-29T22:15:00.000Z', to: '2026-09-29T22:30:00.000Z', price: 0.8884 },
    ]);
    expect(parsePrices(answer, 'EUR').map((period) => period.price)).toEqual([0.08, 0.07845]);
    expect(parsePrices({ error: 'no' }, 'SEK')).toEqual([]);
  });
});

describe('the price now, and its hour’s rank', () => {
  // Hours 0–23 of 30 September; hour 3 is the cheapest, hour 18 the dearest.
  const order = Array.from({ length: 24 }, (_, hour) => (hour === 3 ? 0.1 : hour === 18 ? 3 : 1 + hour / 100));
  const periods = day(30, order);

  test('the period now, and where its hour stands: 1 the cheapest', () => {
    expect(periodAt(periods, at(30, 3, 20))?.price).toBe(0.1);
    expect(rankAt(periods, at(30, 3, 20))).toEqual({ rank: 1, of: 24 });
    expect(rankAt(periods, at(30, 0, 0))).toEqual({ rank: 2, of: 24 });
    expect(rankAt(periods, at(30, 18, 59))).toEqual({ rank: 24, of: 24 });
    expect(periodAt(periods, at(29, 23, 59))).toBeNull();
  });

  test('an hour is ranked at the average of its quarter hours; equal hours share a rank', () => {
    const quarters = day(30, Array(24).fill(1)).map((period, index) => (index < 4 ? { ...period, price: [0, 0, 0, 4][index]! } : period));
    // Hour 0 averages 1, as every other hour: all share the first place.
    expect(rankAt(quarters, at(30, 0, 50))).toEqual({ rank: 1, of: 24 });
    expect(rankAt(quarters, at(30, 12))).toEqual({ rank: 1, of: 24 });
  });

  test('a day known only in part ranks nothing', () => {
    expect(rankAt(periods.slice(0, 40), at(30, 3, 20))).toBeNull();
  });

  test('the days the clocks change have 23 and 25 hours, and are ranked among them', () => {
    expect(hoursIn({ year: 2026, month: 3, day: 29 })).toBe(23);
    expect(hoursIn({ year: 2026, month: 10, day: 25 })).toBe(25);
    const autumn = simulatedDay({ year: 2026, month: 10, day: 25 }, 'SEK');
    expect(autumn).toHaveLength(100);
    expect(rankAt(autumn, Date.parse(autumn[40]!.from))?.of).toBe(25);
  });
});
