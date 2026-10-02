import type { StationState } from '../src/model/types';

/** Theme key to tint the UI with, per station state. */
export const STATE_TINT: Record<StationState, '$success' | '$warning' | '$muted'> = {
  charging: '$success',
  discharging: '$warning',
  idle: '$muted',
  standby: '$muted',
};
