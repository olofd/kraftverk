import { describe, expect, test } from 'bun:test';

import type { HttpChannel } from '@kraftverk/device-sdk';
import { checkDeviceTypeContract, fakeConnection } from '@kraftverk/device-sdk/testing';

import weather from '../src/type.ts';

/** Open-Meteo answering the way its documentation says, for three hours. */
const answer = {
  hourly: {
    time: ['2026-09-28T00:00', '2026-09-28T01:00', '2099-01-01T00:00'],
    temperature_2m: [9.5, 9.1, 7],
    cloud_cover: [80, 65, 10],
    precipitation: [0.2, 0, 0],
    shortwave_radiation: [0, 0, 400],
  },
};

const api = (): HttpChannel & { asked: string[] } => {
  const asked: string[] = [];
  return {
    kind: 'http',
    asked,
    connected: true,
    onConnectedChange: () => () => undefined,
    fetch: async (path) => {
      asked.push(path);
      return new Response(JSON.stringify(answer));
    },
    close: async () => undefined,
  };
};

const connection = (channel = api()) =>
  fakeConnection({ method: 'api', protocol: 'open-meteo', transport: 'https', address: 'https://api.open-meteo.com', channel });

describe('Open-Meteo', () => {
  test('keeps the device-type contract, as a service under Weather', async () => {
    expect(weather.kind).toBe('service');
    expect(weather.meta.category).toBe('weather');
    expect(await checkDeviceTypeContract(weather, { settleMs: 1_500, config: { latitude: 59.33, longitude: 18.07 }, connections: [() => connection()] })).toEqual([]);
  });

  test('its check asks for the forecast at the place given, and has no identity', async () => {
    const channel = api();
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    const found = await weather.identify(connection(channel), { config: { latitude: 59.33, longitude: 18.07 }, log: quiet, signal: AbortSignal.timeout(5000) });
    expect(found.identity).toBeNull();
    expect(found.summary).toContain('3 hours of forecast');
    expect(channel.asked[0]).toContain('latitude=59.3300&longitude=18.0700');
  });
});
