import { localTime, zonedInstant } from '@kraftverk/device-sdk';
import { PRICE_TIME_ZONE, type PriceDay, type PricePeriod } from '@kraftverk/protocol-elprisetjustnu';

/**
 * What a list of price periods says now: the price of the period now, and
 * where the hour now stands among its day's hours — pure, so it is tested
 * without a network and a simulator answers the same way.
 *
 * Periods are quarter hours since October 2025, and were hours before; a
 * rank is of hours either way, each at the average of its periods, so "the
 * cheapest four hours" means the same whatever the market's resolution. A
 * day is the Swedish calendar day the prices are published for — 23 hours
 * in spring, 25 in autumn.
 */

const HOUR_MS = 3_600_000;

/** The period a moment falls in, or null when none known does. */
export const periodAt = (periods: readonly PricePeriod[], at: number): PricePeriod | null =>
  periods.find((period) => Date.parse(period.from) <= at && at < Date.parse(period.to)) ?? null;

/** The calendar day, on the prices' clock, that a moment falls on. */
export const dayOf = (at: number): PriceDay => {
  const { year, month, day } = localTime(new Date(at), PRICE_TIME_ZONE);
  return { year, month, day };
};

/** The day after, on the calendar. */
export const nextDay = ({ year, month, day }: PriceDay): PriceDay => {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
};

const sameDay = (a: PriceDay, b: PriceDay) => a.year === b.year && a.month === b.month && a.day === b.day;

/** How many hours a day has on the prices' clock: 24, or 23 or 25 when the clocks change. */
export const hoursIn = (day: PriceDay): number => {
  const start = zonedInstant({ ...day, hour: 0, minute: 0 }, PRICE_TIME_ZONE).getTime();
  const end = zonedInstant({ ...nextDay(day), hour: 0, minute: 0 }, PRICE_TIME_ZONE).getTime();
  return Math.round((end - start) / HOUR_MS);
};

/**
 * Where the hour of a moment stands among its day's hours by price: 1 is the
 * cheapest, hours that cost the same share a rank. Null when the moment's
 * period is not known, or its day is not known in full — a rank among some
 * of the day's hours would say "cheapest" of an hour that is not.
 */
export function rankAt(periods: readonly PricePeriod[], at: number): { rank: number; of: number } | null {
  if (!periodAt(periods, at)) return null;
  const day = dayOf(at);
  const hours = new Map<number, number[]>();
  for (const period of periods) {
    const from = Date.parse(period.from);
    if (!sameDay(dayOf(from), day)) continue;
    // Whole-hour offsets: an hour on the clock starts on a whole UTC hour.
    const hour = Math.floor(from / HOUR_MS);
    hours.set(hour, [...(hours.get(hour) ?? []), period.price]);
  }
  const of = hoursIn(day);
  if (hours.size !== of) return null;
  const average = (prices: readonly number[]) => prices.reduce((sum, price) => sum + price, 0) / prices.length;
  const averages = [...hours.values()].map(average);
  const now = average(hours.get(Math.floor(at / HOUR_MS))!);
  return { rank: 1 + averages.filter((price) => price < now).length, of };
}

/**
 * A day of made-up prices, per quarter hour: cheap at night, dear in the
 * morning and early evening — what a simulator shows, with no network.
 */
export function simulatedDay(day: PriceDay, currency: 'SEK' | 'EUR'): PricePeriod[] {
  const start = zonedInstant({ ...day, hour: 0, minute: 0 }, PRICE_TIME_ZONE).getTime();
  const quarters = hoursIn(day) * 4;
  const scale = currency === 'SEK' ? 1 : 1 / 11;
  return Array.from({ length: quarters }, (_, index) => {
    const from = start + index * 15 * 60_000;
    const hour = localTime(new Date(from), PRICE_TIME_ZONE).hour;
    const morning = Math.exp(-((hour - 8) ** 2) / 4);
    const evening = Math.exp(-((hour - 18) ** 2) / 6);
    const price = (0.3 + 0.9 * morning + 1.1 * evening + 0.05 * Math.sin(index)) * scale;
    return { from: new Date(from).toISOString(), to: new Date(from + 15 * 60_000).toISOString(), price: Math.round(price * 10_000) / 10_000 };
  });
}
