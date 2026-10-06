import type { HttpChannel, Protocol } from '@kraftverk/device-sdk';

/**
 * The elprisetjustnu.se price API, as a protocol: which request to make for a
 * day's electricity prices in a Swedish price area, and how to read the
 * answer. Pure code — it speaks over the HTTPS channel it is given, which
 * reaches www.elprisetjustnu.se and nothing else.
 *
 * Free, with no key: the Nord Pool day-ahead prices, per quarter hour since
 * October 2025, in SEK and EUR per kWh, excluding tax and fees. A day is the
 * Swedish calendar day; tomorrow's is published after about 13:00, and asked
 * for before then answers 404. https://www.elprisetjustnu.se/elpris-api
 */

export const ELPRISET = 'https://www.elprisetjustnu.se';

/** Sweden's four price areas, north to south. */
export const PRICE_AREAS = ['SE1', 'SE2', 'SE3', 'SE4'] as const;
export type PriceArea = (typeof PRICE_AREAS)[number];

/** The currencies the API answers in. */
export const CURRENCIES = ['SEK', 'EUR'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** The clock the API's days are on. */
export const PRICE_TIME_ZONE = 'Europe/Stockholm';

/** One period's price: from when, until when, per kWh in the currency asked for. */
export type PricePeriod = { from: string; to: string; price: number };

/** A calendar day, as the API names one. */
export type PriceDay = { year: number; month: number; day: number };

const two = (value: number) => String(value).padStart(2, '0');

/** The path for a day's prices in an area: "/api/v1/prices/2026/09-30_SE3.json". */
export const pricesPath = (day: PriceDay, area: PriceArea): string => `/api/v1/prices/${day.year}/${two(day.month)}-${two(day.day)}_${area}.json`;

type Entry = { SEK_per_kWh?: unknown; EUR_per_kWh?: unknown; time_start?: unknown; time_end?: unknown };

/** Reads an answer into periods, oldest first. Anything malformed is left out, never guessed. */
export function parsePrices(body: unknown, currency: Currency): PricePeriod[] {
  if (!Array.isArray(body)) return [];
  return (body as Entry[])
    .flatMap((entry) => {
      const price = currency === 'SEK' ? entry?.SEK_per_kWh : entry?.EUR_per_kWh;
      const from = typeof entry?.time_start === 'string' ? new Date(entry.time_start) : null;
      const to = typeof entry?.time_end === 'string' ? new Date(entry.time_end) : null;
      if (typeof price !== 'number' || !Number.isFinite(price) || !from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return [];
      return [{ from: from.toISOString(), to: to.toISOString(), price }];
    })
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
}

/** Asks for a day's prices in an area over the channel. A day not published yet has none: an empty list, not an error. */
export async function fetchDay(channel: HttpChannel, day: PriceDay, area: PriceArea, currency: Currency): Promise<PricePeriod[]> {
  const response = await channel.fetch(pricesPath(day, area), { headers: { accept: 'application/json' }, timeoutMs: 15_000 });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`elprisetjustnu.se answered HTTP ${response.status}`);
  return parsePrices(await response.json(), currency);
}

const protocol: Protocol = {
  id: 'elprisetjustnu',
  label: 'Elpriset just nu',
  bindings: {
    https: {
      open: () => ({}),
      // A web API is not found; its address is fixed by the service's method.
      recognise: () => null,
    },
  },
};

export default protocol;
