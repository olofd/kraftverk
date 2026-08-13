import type { StationSettings, StationState } from '@kraftverk/protocol';

export function formatWatts(watts: number): string {
  if (watts >= 1000) return `${(watts / 1000).toFixed(2)} kW`;
  return `${Math.round(watts)} W`;
}

export function formatWh(wh: number): string {
  return `${Math.round(wh).toLocaleString()} Wh`;
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return '—';

  // A P280 sitting idle reports genuine multi-week runtimes (20 000+ minutes),
  // so hours alone stops being readable.
  const days = Math.floor(minutes / 1440);
  if (days >= 1) {
    const hours = Math.round((minutes % 1440) / 60);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
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

export function formatTemperature(celsius: number, unit: StationSettings['temperatureUnit']) {
  return unit === 'F'
    ? `${Math.round(celsius * 1.8 + 32)}°F`
    : `${celsius.toFixed(1)}°C`;
}

export const STATE_LABELS: Record<StationState, string> = {
  charging: 'Charging',
  discharging: 'On battery',
  idle: 'Idle',
  standby: 'Standby',
};

/** Theme key to tint the UI with, per station state. */
export const STATE_TINT: Record<StationState, '$success' | '$warning' | '$muted'> = {
  charging: '$success',
  discharging: '$warning',
  idle: '$muted',
  standby: '$muted',
};
