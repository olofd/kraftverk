import type { StationState } from '../src/model/types';

/** What each of the station's states is called on screen. */
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
