import { savedDeviceId, type SavedDeviceId } from '@kraftverk/device-sdk';

import type { StationReading } from '../actions/gateway.ts';
import type { DeviceSessionManager } from './sessions.ts';
import { appState, setAppState } from '../history/db.ts';

/**
 * Which saved station the grid relay feeds.
 *
 * Stored, not derived. A rule like "the only station" is a fact that stops
 * being true the moment a second one is added, and what it decides is whether
 * cutting mains is verified against the right machine.
 */
export const RELAY_STATION_KEY = 'gridRelay.stationDeviceId';

/** The paired station's id, or null. `app_state` stores '' for "cleared". */
export function pairedStation(): SavedDeviceId | null {
  const id = appState(RELAY_STATION_KEY);
  return id ? savedDeviceId(id) : null;
}

export function pairStation(id: SavedDeviceId | null): void {
  setAppState(RELAY_STATION_KEY, id ?? '');
}

/**
 * The station the relay is proved against — by recorded id, never by whichever
 * session happens to be open.
 *
 * The gateway's second proof is *the* station's AC input agreeing that mains
 * came or went. Read from the wrong station it proves nothing, and would
 * happily report `verified` because some other station has power while the one
 * this plug feeds sat dark. So if the station it names is gone or has no
 * session, the answer is "I cannot verify" rather than a substitute.
 */
export function relayStation(sessions: DeviceSessionManager): StationReading {
  const deviceId = pairedStation();
  if (!deviceId) {
    return {
      reading: null,
      reason:
        'No station is paired with the grid relay, so switching it cannot be verified. Choose the station it feeds in the relay’s setup, under Extensions.',
    };
  }
  const session = sessions.get(deviceId);
  if (!session) return { reading: null, reason: `The station paired with the relay (${deviceId}) has no open session.` };
  const input = session.capability('acInput');
  if (!input) return { reading: null, reason: 'The device paired with the relay does not report its AC input.' };
  const read = input.read();
  return {
    reading: { connected: session.health().status === 'connected', present: read?.present ?? null, at: read?.at ?? null },
  };
}
