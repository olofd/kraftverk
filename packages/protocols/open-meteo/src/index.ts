import type { HttpChannel, Protocol } from '@kraftverk/device-sdk';

/**
 * The Open-Meteo forecast API, as a protocol: which request to make for a
 * place, and how to read the answer. Pure code — it speaks over the HTTPS
 * channel it is given, which reaches api.open-meteo.com and nothing else.
 *
 * Free, with no key, and worldwide: why it is the first weather service
 * (docs/ARCHITECTURE.md, step 13). https://open-meteo.com/en/docs
 */

export const OPEN_METEO = 'https://api.open-meteo.com';

export type Place = { latitude: number; longitude: number };

/**
 * One hour of a forecast: what `weather.forecast`'s `hourly` query answers
 * with, a list of. This service's shape, kept here rather than in the core; a
 * forecast from anywhere else that answers the same query answers in it too.
 */
export type WeatherHour = {
  /** The start of the hour. */
  at: string;
  temperatureC: number | null;
  cloudCoverPercent: number | null;
  precipitationMm: number | null;
  /** Global horizontal irradiance: what reaches a panel lying flat. */
  irradianceWm2: number | null;
};

/** The hourly forecast for a place, three days ahead, in UTC. */
export const forecastPath = ({ latitude, longitude }: Place): string =>
  `/v1/forecast?latitude=${latitude.toFixed(4)}&longitude=${longitude.toFixed(4)}` +
  '&hourly=temperature_2m,cloud_cover,precipitation,shortwave_radiation&forecast_days=3&timezone=UTC';

type Response = {
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    cloud_cover?: (number | null)[];
    precipitation?: (number | null)[];
    shortwave_radiation?: (number | null)[];
  };
};

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Reads an answer into forecast hours. Anything malformed is left out, never guessed. */
export function parseForecast(body: unknown): WeatherHour[] {
  const hourly = (body as Response | null)?.hourly;
  if (!hourly?.time?.length) return [];
  return hourly.time.flatMap((time, i) => {
    // Open-Meteo gives UTC times without a zone when asked for UTC.
    const at = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(time) ? time : `${time}Z`);
    if (Number.isNaN(at.getTime())) return [];
    return [
      {
        at: at.toISOString(),
        temperatureC: numberOrNull(hourly.temperature_2m?.[i]),
        cloudCoverPercent: numberOrNull(hourly.cloud_cover?.[i]),
        precipitationMm: numberOrNull(hourly.precipitation?.[i]),
        irradianceWm2: numberOrNull(hourly.shortwave_radiation?.[i]),
      },
    ];
  });
}

/** Asks for a place's forecast over the channel, and reads it. */
export async function fetchForecast(channel: HttpChannel, place: Place): Promise<WeatherHour[]> {
  const response = await channel.fetch(forecastPath(place), { headers: { accept: 'application/json' }, timeoutMs: 15_000 });
  if (!response.ok) throw new Error(`Open-Meteo answered HTTP ${response.status}`);
  const hours = parseForecast(await response.json());
  if (!hours.length) throw new Error('Open-Meteo answered with no forecast');
  return hours;
}

const protocol: Protocol = {
  id: 'open-meteo',
  label: 'Open-Meteo',
  bindings: {
    https: {
      open: () => ({}),
      // A web API is not found; its address is fixed by the service's method.
      recognise: () => null,
    },
  },
};

export default protocol;
