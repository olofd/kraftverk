import { describe, expect, test } from 'bun:test';

import { capabilitiesOf, MAIN_PART, type HttpChannel } from '@kraftverk/device-sdk';
import { checkDeviceTypeContract, fakeConnection } from '@kraftverk/device-sdk/testing';

import { dayOf, nextDay, simulatedDay } from '../src/prices.ts';
import prices from '../src/type.ts';

/** elprisetjustnu.se answering as it does: today's prices, and none yet for tomorrow. */
const api = (): HttpChannel & { asked: string[] } => {
  const asked: string[] = [];
  const today = dayOf(Date.now());
  const answer = simulatedDay(today, 'SEK').map((period) => ({ SEK_per_kWh: period.price, EUR_per_kWh: period.price / 11, EXR: 11, time_start: period.from, time_end: period.to }));
  const tomorrow = nextDay(today);
  return {
    kind: 'http',
    asked,
    connected: true,
    onConnectedChange: () => () => undefined,
    fetch: async (path) => {
      asked.push(path);
      return path.includes(`${String(tomorrow.month).padStart(2, '0')}-${String(tomorrow.day).padStart(2, '0')}_`) ? new Response('Not found', { status: 404 }) : new Response(JSON.stringify(answer));
    },
    close: async () => undefined,
  };
};

const connection = (channel = api()) => fakeConnection({ method: 'api', protocol: 'elprisetjustnu', transport: 'https', address: 'https://www.elprisetjustnu.se', channel });

describe('Elpriset just nu', () => {
  test('keeps the device-type contract, as a service under Electricity prices', async () => {
    expect(prices.kind).toBe('service');
    expect(prices.meta.category).toBe('energy-price');
    expect(await checkDeviceTypeContract(prices, { settleMs: 1_500, config: { area: 'SE3', currency: 'SEK' }, connections: [() => connection()] })).toEqual([]);
  });

  test('offers a price, in the currency chosen — what a recipe for the cheapest hours asks for', () => {
    expect(capabilitiesOf(prices.describe({ area: 'SE3', currency: 'SEK' }), MAIN_PART)).toEqual(['energyPrice']);
    expect(prices.describe({ area: 'SE1', currency: 'EUR' }).attributes.find((attribute) => attribute.key === 'price')?.value).toMatchObject({ unit: 'EUR/kWh' });
  });

  test('its check asks for today in the area given, and says the price now and its hour’s rank', async () => {
    const channel = api();
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    const found = await prices.identify(connection(channel), { config: { area: 'SE4', currency: 'SEK' }, log: quiet, signal: AbortSignal.timeout(5000) });
    expect(found.identity).toBeNull();
    expect(found.summary).toMatch(/^SE4: \d+\.\d\d SEK\/kWh now, ranked \d+ of 2[345] hours by price today\.$/);
    expect(channel.asked[0]).toEndWith('_SE4.json');
  });
});
