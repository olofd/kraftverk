import type { DeviceScreenProps } from '@kraftverk/api-client';

import type { PortId, StationSettings, StationSettingsPatch, StationStatus } from '../src/model/types';
import type { WritesInFlight } from '../src/writes';

export type { DeviceScreenProps, WritesInFlight };

/**
 * What the P280's screens draw from: the station's own state, and ways to
 * change it — built by `useStation` from what the app hands every device's
 * screens (`DeviceScreenProps`). The app never sees this shape.
 *
 * Screens return *content*. The frame around it — page padding, the offline
 * banner, the status dot — is the app's chrome and stays there.
 */
export type StationView = {
  status: StationStatus | null;
  settings: StationSettings | null;
  /** Writes the station has not confirmed yet. Their values are already shown above. */
  pending: WritesInFlight;
  /** True when every write is being refused. */
  readOnly: boolean;
  simulated: boolean;
  /** This app holds the station's connection itself, over its own radio. */
  direct: boolean;
  /** What the screen is waiting for, before the station has said anything. */
  waitingFor: string;
  /** Only when a server is in the path. */
  version: { version: string; runtime: string; uptimeSeconds: number; readOnly: boolean } | null;
  /** How the connection in use is described: "Wi-Fi, through the server". */
  linkLabel: string | null;
  /** Never true now: a connection this app holds reconnects by itself. */
  resuming: boolean;
  /** Why the last change did not happen, until the next one is asked for. */
  writeError: string | null;
  updateSettings: (patch: StationSettingsPatch) => Promise<void>;
  togglePort: (id: PortId, enabled: boolean) => Promise<void>;
};
