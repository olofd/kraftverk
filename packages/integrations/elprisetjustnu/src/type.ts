import { defineDeviceType, MAIN_PART, type DeviceContext, type DeviceDescription, type DeviceSession, type Reading } from '@kraftverk/device-sdk';
import { CURRENCIES, ELPRISET, fetchDay, PRICE_AREAS, type Currency, type PriceArea, type PricePeriod } from '@kraftverk/protocol-elprisetjustnu';

import { dayOf, nextDay, periodAt, rankAt, simulatedDay } from './prices.ts';

/**
 * Sweden's electricity prices, as a service: a device with no hardware, added
 * and shown like any other (docs/PLAN-RUN-AND-CHAIN.md, Phase 4). Its part is
 * a price area; it reports what electricity costs now (`price`) and where
 * the hour now stands among the day's hours by price (`priceRank`) — so "the
 * cheapest four hours" is a condition like any other, which `becomes`, keeping
 * things so and rehearsal all understand.
 *
 * Only the price area is sent, to ask for its prices. A reading's time is when
 * its period began: the price is a published fact for that quarter hour.
 */

type PriceConfig = { area: PriceArea; currency: Currency };

/** How often to ask. Tomorrow's prices arrive after about 13:00; this finds them within the half hour. */
const REFRESH_MS = 30 * 60_000;

/** How long a period's reading stays current: its quarter hour, and a little. */
const CURRENT_FOR_MS = 20 * 60_000;

/** How often it looks whether a new period has begun, to say so. */
const TICK_MS = 30_000;

const description = (currency: Currency): DeviceDescription => ({
  parts: [{ id: MAIN_PART, label: 'Price area', kind: 'place' }],
  attributes: [
    {
      key: 'price',
      label: 'Electricity price',
      value: { type: 'number', unit: `${currency}/kWh`, precision: currency === 'SEK' ? 2 : 3 },
      quantity: 'price',
      means: 'price',
      category: 'primary',
      currentFor: CURRENT_FOR_MS,
    },
    {
      key: 'rank',
      label: 'Price rank today',
      description: 'Where the hour now stands among the day’s hours by price: 1 is the cheapest.',
      value: { type: 'number', integer: true, min: 1, max: 25 },
      quantity: 'rank',
      means: 'priceRank',
      currentFor: CURRENT_FOR_MS,
    },
  ],
});

function priceSession(options: { periods: () => readonly PricePeriod[]; health: DeviceSession['health']; close: () => Promise<void> }): DeviceSession {
  return {
    health: options.health,
    readings(): Reading[] {
      const now = Date.now();
      const periods = options.periods();
      const period = periodAt(periods, now);
      if (!period) return [];
      const ranked = rankAt(periods, now);
      return [{ key: 'price', value: period.price, at: period.from }, ...(ranked ? [{ key: 'rank', value: ranked.rank, at: period.from }] : [])];
    },
    command: async () => ({ accepted: false, error: 'Prices take no commands' }),
    close: options.close,
  };
}

/** Says so when a new period has begun: its readings moved, with nothing fetched. */
function sayEachPeriod(ctx: DeviceContext<PriceConfig>, periods: () => readonly PricePeriod[]): void {
  let current: string | null = null;
  ctx.schedule(TICK_MS, () => {
    const now = periodAt(periods(), Date.now())?.from ?? null;
    if (now !== current) {
      current = now;
      ctx.changed();
    }
  });
}

async function realSession(ctx: DeviceContext<PriceConfig>): Promise<DeviceSession> {
  const connection = ctx.connection;
  if (connection?.channel.kind !== 'http') throw new Error('A price service needs its web API');
  const channel = connection.channel;
  let periods: PricePeriod[] = ctx.store.get<PricePeriod[]>('periods') ?? [];
  let fetchedAt: string | null = ctx.store.get<string>('fetchedAt');
  let lastError: string | null = null;

  const refresh = async () => {
    try {
      const today = dayOf(Date.now());
      const [now, tomorrow] = await Promise.all([fetchDay(channel, today, ctx.config.area, ctx.config.currency), fetchDay(channel, nextDay(today), ctx.config.area, ctx.config.currency)]);
      if (!now.length) throw new Error('elprisetjustnu.se has no prices for today yet');
      periods = [...now, ...tomorrow];
      fetchedAt = new Date().toISOString();
      lastError = null;
      // Kept, so a restart has today's prices before the next fetch.
      ctx.store.set('periods', periods);
      ctx.store.set('fetchedAt', fetchedAt);
      ctx.changed();
    } catch (error) {
      // What was fetched stays, as long as it covers now: prices do not change once published.
      lastError = (error as Error).message;
    }
  };
  ctx.schedule(REFRESH_MS, refresh);
  sayEachPeriod(ctx, () => periods);
  void refresh();

  return priceSession({
    periods: () => periods,
    health: () => {
      const known = periodAt(periods, Date.now()) !== null;
      const last = periods.at(-1);
      return {
        status: known ? 'connected' : lastError ? 'error' : 'connecting',
        detail: known && last ? `Prices until ${new Date(last.to).toLocaleString()}` : (lastError ?? 'Asking for the prices'),
        lastReadingAt: fetchedAt,
      };
    },
    close: async () => undefined,
  });
}

/** Prices with no internet: made-up days, cheap at night and dear at the peaks. */
function simulatedSession(ctx: DeviceContext<PriceConfig>): DeviceSession {
  const periods = () => {
    const today = dayOf(Date.now());
    return [...simulatedDay(today, ctx.config.currency), ...simulatedDay(nextDay(today), ctx.config.currency)];
  };
  sayEachPeriod(ctx, periods);
  return priceSession({ periods, health: () => ({ status: 'connected', detail: 'Simulated', lastReadingAt: new Date().toISOString() }), close: async () => undefined });
}

const AREA_OPTIONS = [
  { value: 'SE1', label: 'SE1 — Luleå' },
  { value: 'SE2', label: 'SE2 — Sundsvall' },
  { value: 'SE3', label: 'SE3 — Stockholm' },
  { value: 'SE4', label: 'SE4 — Malmö' },
] satisfies { value: PriceArea; label: string }[];

const CURRENCY_OPTIONS = CURRENCIES.map((currency) => ({ value: currency, label: currency === 'SEK' ? 'Kronor (SEK)' : 'Euro (EUR)' }));

export default defineDeviceType<PriceConfig>({
  id: 'elprisetjustnu.prices',
  kind: 'service',
  meta: {
    name: 'Elpriset just nu',
    brand: 'elprisetjustnu.se',
    category: 'energy-price',
    description: 'Sweden’s electricity spot prices for your price area, per quarter hour, with no account. Only your price area is sent.',
    support: 'verified',
    supportNote: 'A public API, read the way its documentation says, and checked against its answers.',
    icon: 'tag',
    docsUrl: 'https://www.elprisetjustnu.se/elpris-api',
  },
  describe: (config) => description(config.currency ?? 'SEK'),
  config: {
    fields: {
      area: { type: 'enum', title: 'Price area', description: 'Where you are: your electricity bill says which.', options: AREA_OPTIONS, default: 'SE3', required: true },
      currency: { type: 'enum', title: 'Currency', options: CURRENCY_OPTIONS, default: 'SEK', required: true },
    },
  },
  connections: [
    {
      id: 'api',
      label: 'elprisetjustnu.se',
      description: 'Its public price API, over the internet. No account and no key.',
      protocol: 'elprisetjustnu',
      transport: 'https',
      address: ELPRISET,
      reach: 'cloud',
    },
  ],
  setup: {
    steps: [
      {
        id: 'area',
        kind: 'form',
        target: 'device',
        title: 'Which price area?',
        description: 'Sweden has four; your electricity bill says which you are in.',
        schema: {
          fields: {
            area: { type: 'enum', title: 'Price area', options: AREA_OPTIONS, default: 'SE3', required: true },
            currency: { type: 'enum', title: 'Currency', options: CURRENCY_OPTIONS, default: 'SEK', required: true },
          },
        },
      },
    ],
  },

  async identify(connection, ctx) {
    if (connection.channel.kind !== 'http') throw new Error('A price service needs its web API');
    const area = String(ctx.config.area ?? 'SE3') as PriceArea;
    const currency = String(ctx.config.currency ?? 'SEK') as Currency;
    if (!PRICE_AREAS.includes(area)) throw new Error('Choose a price area first');
    const periods = await fetchDay(connection.channel, dayOf(Date.now()), area, currency);
    if (!periods.length) throw new Error('elprisetjustnu.se has no prices for today yet');
    const now = periodAt(periods, Date.now());
    const ranked = rankAt(periods, Date.now());
    return {
      identity: null,
      model: null,
      summary: `${area}: ${now ? `${now.price.toFixed(2)} ${currency}/kWh now` : 'no price for now'}${ranked ? `, ranked ${ranked.rank} of ${ranked.of} hours by price today` : ''}.`,
    };
  },

  createSession: realSession,
  createSimulator: async (ctx) => simulatedSession(ctx),
});
