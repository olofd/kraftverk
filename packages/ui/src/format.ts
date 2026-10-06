/** Watts, as kW from a kilowatt on — what rounds to 1000 W is 1.00 kW, and a negative flow too. */
export function formatWatts(watts: number): string {
  const rounded = Math.round(watts);
  if (Math.abs(rounded) >= 1000) return `${(watts / 1000).toFixed(2)} kW`;
  // Not "-0 W".
  return `${rounded || 0} W`;
}

export function formatWh(wh: number): string {
  return `${Math.round(wh).toLocaleString()} Wh`;
}

/**
 * A length of time from minutes: "20s", "45m", "1h 5m", "2d 3h". Rounded
 * once, to what it shows, then split — 59.6 min is "1h", never "60m", and
 * 2870 min "2d", never "1d 24h". None, or none to speak of: "—".
 */
export function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return '—';

  const seconds = Math.round(minutes * 60);
  if (seconds < 60) return `${seconds}s`;

  // A battery sitting idle reports genuine multi-week runtimes (20 000+
  // minutes), so hours alone stops being readable.
  const hoursInAll = Math.round(minutes / 60);
  if (hoursInAll >= 24) {
    const days = Math.floor(hoursInAll / 24);
    const hours = hoursInAll % 24;
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  const whole = Math.round(minutes);
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return formatDuration(seconds / 60);
}

/** "just now" / "12 minutes ago" / "yesterday" — for a remembered connection. */
export function formatAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'earlier';

  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * How old a reading is, at the resolution a live device deserves.
 *
 * `formatAgo` rounds everything under a minute to "just now", which is right
 * for a connection you made yesterday and wrong for telemetry: the difference
 * between four seconds and fifty is the difference between a live device and
 * one that has quietly stopped answering.
 */
export function formatFresh(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return formatAgo(iso);
}

export function formatTemperature(celsius: number, unit: 'C' | 'F') {
  return unit === 'F'
    ? `${Math.round(celsius * 1.8 + 32)}°F`
    : `${celsius.toFixed(1)}°C`;
}

/** A phrase begun as a sentence: "this phone" → "This phone". */
export const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Where something is, as a map says it: "59.33° N, 18.07° E". */
export const formatCoordinates = ({ latitude, longitude }: { latitude: number; longitude: number }): string =>
  `${Math.abs(latitude).toFixed(2)}° ${latitude < 0 ? 'S' : 'N'}, ${Math.abs(longitude).toFixed(2)}° ${longitude < 0 ? 'W' : 'E'}`;
