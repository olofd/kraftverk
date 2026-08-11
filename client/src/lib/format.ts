import type { StationSettings, StationState } from './types';

export function formatWatts(watts: number): string {
  if (watts >= 1000) return `${(watts / 1000).toFixed(2)} kW`;
  return `${Math.round(watts)} W`;
}

export function formatWh(wh: number): string {
  return `${Math.round(wh).toLocaleString()} Wh`;
}

export function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return formatDuration(seconds / 60);
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
