import {
  defineDeviceType,
  MAIN_PART,
  type DeviceContext,
  type DeviceDescription,
  type DeviceSession,
  type Reading,
  channelOf,
} from '@kraftverk/device-sdk';
import { fetchForecast, OPEN_METEO, type WeatherHour } from './protocol/index.ts';


/**
 * Weather from Open-Meteo, as a service: a device with no hardware, added and
 * shown like any other, in its own section (docs/ARCHITECTURE.md, step 13).
 *
 * It offers `weather.forecast` — what the charging recipes plan with — and the
 * current hour's temperature and cloud cover as attributes, so they are charted
 * like any measurement. Its place is its config; the place is sent to
 * Open-Meteo to ask for the forecast, and nowhere else.
 *
 * A reading's time is when the forecast was fetched — when the value was
 * observed — not the hour it is about; the hour is in the forecast's own data.
 * A forecast stays current for an hour: two fetches, so one that fails does
 * not leave a gap in history.
 */

type WeatherConfig = { latitude: number; longitude: number; place?: string };

/** How often to ask. The forecast changes a few times a day; this is plenty. */
const REFRESH_MS = 30 * 60_000;

/** How long a fetched forecast's hour stays current: two fetches. */
const CURRENT_FOR_MS = 2 * REFRESH_MS;

const DESCRIPTION: DeviceDescription = {
  // What it is: the weather at a place. A forecast is what it offers.
  parts: [{ id: MAIN_PART, label: 'Weather', kind: 'place', offers: ['weather.forecast'] }],
  attributes: [
    {
      key: 'temperature',
      label: 'Temperature',
      value: { type: 'number', unit: '°C', precision: 1 },
      quantity: 'temperature',
      means: 'temperature',
      category: 'primary',
      currentFor: CURRENT_FOR_MS,
    },
    {
      key: 'cloudCover',
      label: 'Cloud cover',
      value: { type: 'number', unit: '%', precision: 0 },
      quantity: 'percent',
      means: 'cloudCover',
      currentFor: CURRENT_FOR_MS,
    },
  ],
};

const hourOf = (hours: readonly WeatherHour[], at = Date.now()): WeatherHour | null => {
  let current: WeatherHour | null = null;
  for (const hour of hours) {
    if (Date.parse(hour.at) <= at) current = hour;
    else break;
  }
  return current;
};

function weatherSession(options: {
  hours: () => readonly WeatherHour[];
  fetchedAt: () => string | null;
  health: DeviceSession['health'];
  close: () => Promise<void>;
}): DeviceSession {
  const hourly = (count: number): WeatherHour[] => {
    const now = Date.now() - 3_600_000;
    return options.hours().filter((hour) => Date.parse(hour.at) >= now).slice(0, count);
  };
  return {
    health: options.health,
    readings(): Reading[] {
      const hour = hourOf(options.hours());
      const at = options.fetchedAt();
      if (!hour || !at) return [];
      // Observed when it was fetched: the hour it is about is not when anyone saw it.
      return [
        { key: 'temperature', value: hour.temperature, at },
        { key: 'cloudCover', value: hour.cloudCover, at },
      ];
    },
    command: async () => ({ accepted: false, error: 'A forecast takes no commands' }),
    async query(request) {
      if (request.capability !== 'weather.forecast' || request.query !== 'hourly') throw new Error(`A forecast answers no ${request.capability}.${request.query}`);
      return hourly(typeof request.args.hours === 'number' ? request.args.hours : 24);
    },
    close: options.close,
  };
}

async function realSession(ctx: DeviceContext<WeatherConfig>): Promise<DeviceSession> {
  const channel = channelOf(ctx.connection, 'http', 'A weather service needs its web API');
  let hours: WeatherHour[] = ctx.store.get<WeatherHour[]>('forecast') ?? [];
  let fetchedAt: string | null = ctx.store.get<string>('fetchedAt');
  let lastError: string | null = null;

  const refresh = async () => {
    try {
      hours = await fetchForecast(channel, ctx.config);
      fetchedAt = new Date().toISOString();
      lastError = null;
      // Kept, so a restart has a forecast before the next one arrives.
      ctx.store.set('forecast', hours);
      ctx.store.set('fetchedAt', fetchedAt);
    } catch (error) {
      // The old forecast stays, with its age: a stale forecast that says so
      // beats none, and nothing acts on one without checking.
      lastError = (error as Error).message;
    }
  };
  ctx.schedule(REFRESH_MS, refresh);
  void refresh();

  return weatherSession({
    hours: () => hours,
    fetchedAt: () => fetchedAt,
    health: () => {
      const fresh = fetchedAt !== null && Date.now() - Date.parse(fetchedAt) < REFRESH_MS * 3;
      return {
        status: fresh ? 'connected' : lastError ? 'error' : 'connecting',
        detail: fresh ? `Forecast from ${new Date(fetchedAt!).toLocaleTimeString()}` : (lastError ?? 'Asking for the forecast'),
        lastReadingAt: fetchedAt,
      };
    },
    close: async () => undefined,
  });
}

/** A forecast with no internet: a day's worth of temperature and cloud, repeating. */
function simulatedSession(ctx: DeviceContext<WeatherConfig>): DeviceSession {
  const hours = (): WeatherHour[] => {
    const start = new Date();
    start.setUTCMinutes(0, 0, 0);
    return Array.from({ length: 72 }, (_, i) => {
      const at = new Date(start.getTime() + (i - 1) * 3_600_000);
      const daylight = Math.max(0, Math.sin(((at.getUTCHours() - 6) / 12) * Math.PI));
      const cloud = Math.round(50 + 40 * Math.sin(i / 7));
      return {
        at: at.toISOString(),
        temperature: Math.round((8 + 8 * daylight) * 10) / 10,
        cloudCover: cloud,
        precipitation: cloud > 80 ? 0.4 : 0,
        irradiance: Math.round(800 * daylight * (1 - cloud / 130)),
      };
    });
  };
  let at = new Date().toISOString();
  ctx.schedule(60_000, () => {
    at = new Date().toISOString();
  });
  return weatherSession({
    hours,
    fetchedAt: () => at,
    health: () => ({ status: 'connected', detail: 'Simulated', lastReadingAt: at }),
    close: async () => undefined,
  });
}

export default defineDeviceType<WeatherConfig>({
  id: 'open-meteo.weather',
  kind: 'service',
  meta: {
    name: 'Open-Meteo',
    brand: 'Open-Meteo',
    category: 'weather',
    description: 'Free weather forecasts for anywhere, with no account. Your place is sent to Open-Meteo to ask for its forecast.',
    support: 'verified',
    supportNote: 'A public API, read the way its documentation says.',
    icon: 'cloud',
    docsUrl: 'https://open-meteo.com/en/docs',
  },
  describe: () => DESCRIPTION,
  config: {
    fields: {
      place: { type: 'string', title: 'Place', description: 'What you call it: “Home”, “The cabin”.', placeholder: 'Home' },
      latitude: { type: 'number', title: 'Latitude', description: 'Degrees north; south is negative.', required: true, min: -90, max: 90 },
      longitude: { type: 'number', title: 'Longitude', description: 'Degrees east; west is negative.', required: true, min: -180, max: 180 },
    },
  },
  connections: [
    {
      id: 'api',
      label: 'Open-Meteo',
      description: 'Its public forecast API, over the internet. No account and no key.',
      protocol: 'open-meteo',
      transport: 'https',
      address: OPEN_METEO,
      reach: 'cloud',
    },
  ],
  setup: {
    steps: [
      {
        id: 'place',
        kind: 'form',
        target: 'device',
        title: 'Where?',
        description: 'The forecast is for this spot. Two decimals — about a kilometre — is plenty.',
        schema: {
          fields: {
            place: { type: 'string', title: 'Place', placeholder: 'Home' },
            latitude: { type: 'number', title: 'Latitude', required: true, min: -90, max: 90 },
            longitude: { type: 'number', title: 'Longitude', required: true, min: -180, max: 180 },
          },
        },
      },
    ],
  },

  async identify(connection, ctx) {
    const channel = channelOf(connection, 'http', 'A weather service needs its web API');
    const latitude = Number(ctx.config.latitude);
    const longitude = Number(ctx.config.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('Give a latitude and a longitude first');
    const hours = await fetchForecast(channel, { latitude, longitude });
    const now = hourOf(hours);
    return {
      identity: null,
      model: null,
      summary: `${now?.temperature ?? '?'} °C now, ${now?.cloudCover ?? '?'} % cloud; ${hours.length} hours of forecast.`,
    };
  },

  createSession: realSession,
  createSimulator: async (ctx) => simulatedSession(ctx),
});
