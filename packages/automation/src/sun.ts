import type { SunEvent } from './rule.ts';

/*
  When the sun rises and sets, where a home is: the sunrise equation, as
  astronomers give it — to a minute or so, which is what a lamp at dusk
  needs. Pure: a date and coordinates in, two instants out — or none, on a day
  the sun stays up or stays down.
*/

/** Where a home is, in degrees: north and east positive. */
export type Coordinates = { latitude: number; longitude: number };

/** A calendar date: what "today" is on the owner's clock. */
export type CalendarDay = { year: number; month: number; day: number };

const RADIANS = Math.PI / 180;
const DAY_MS = 86_400_000;
/** The Julian day of the Unix epoch. */
const J1970 = 2_440_587.5;
/** The Julian day of 1 January 2000, noon: the epoch the equation counts from. */
const J2000 = 2_451_545;
/** The sun's centre this far below the horizon is sunrise or sunset: refraction and its own size. */
const HORIZON = -0.833;
/** The tilt of the Earth's axis. */
const OBLIQUITY = 23.4397;

const fromJulian = (julian: number): number => (julian - J1970) * DAY_MS;

/** Sunrise and sunset on a day, where a home is, as instants (ms) — each null when the sun does not cross the horizon that day. */
export function sunTimes(day: CalendarDay, coordinates: Coordinates): { sunrise: number | null; sunset: number | null } {
  // Days since J2000 at the home's own noon.
  const midnight = Date.UTC(day.year, day.month - 1, day.day) / DAY_MS + J1970;
  const cycle = Math.round(midnight - J2000 + 0.0008 - coordinates.longitude / 360);
  const noon = cycle - coordinates.longitude / 360;
  const anomaly = (357.5291 + 0.98560028 * noon) % 360;
  const centre = 1.9148 * Math.sin(anomaly * RADIANS) + 0.02 * Math.sin(2 * anomaly * RADIANS) + 0.0003 * Math.sin(3 * anomaly * RADIANS);
  const ecliptic = (anomaly + centre + 180 + 102.9372) % 360;
  const transit = J2000 + noon + 0.0053 * Math.sin(anomaly * RADIANS) - 0.0069 * Math.sin(2 * ecliptic * RADIANS);
  const declination = Math.asin(Math.sin(ecliptic * RADIANS) * Math.sin(OBLIQUITY * RADIANS));
  const latitude = coordinates.latitude * RADIANS;
  const cosHour = (Math.sin(HORIZON * RADIANS) - Math.sin(latitude) * Math.sin(declination)) / (Math.cos(latitude) * Math.cos(declination));
  // Up all day, or down all day: no sunrise and no sunset.
  if (cosHour < -1 || cosHour > 1) return { sunrise: null, sunset: null };
  const hour = Math.acos(cosHour) / RADIANS / 360;
  return { sunrise: fromJulian(transit - hour), sunset: fromJulian(transit + hour) };
}

/** Each event of the sun, as a sentence and a file say it. */
export const SUN_EVENTS: { readonly [E in SunEvent]: string } = { sunrise: 'sunrise', sunset: 'sunset' };

export const isSunEvent = (name: string): name is SunEvent => Object.hasOwn(SUN_EVENTS, name);

/** How far before or after the sun an event may be: up to twelve hours. */
export const SUN_OFFSET_SECONDS = { min: 60, max: 12 * 3_600 } as const;
