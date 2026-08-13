import type {
  PortId,
  RegisterDump,
  StationSettings,
  StationSettingsPatch,
  StationStatus,
} from '@kraftverk/protocol';

/**
 * What the app hands a P280 screen.
 *
 * The device package draws the screens; it does not know how the app talks to
 * anything. No provider, no HTTP client, no Bluetooth — just the current state
 * and functions to ask for changes. That is what lets these screens work
 * whether the app is talking to a server or holding the station's Bluetooth
 * link itself, and what stops a device package reaching into the app that
 * renders it.
 *
 * Screens return *content*. The frame around it — page padding, the offline
 * banner, the status dot — is the app's chrome and stays there.
 */
/**
 * What the protocol screen needs.
 *
 * The device package draws the register table; it does not know how the bytes
 * are fetched. The app injects those calls, which is what lets the same screen
 * work whether the registers came over HTTP from a server or straight off a
 * Bluetooth link the app is holding itself.
 */
export type ProtocolScreenProps = {
  status: StationStatus | null;
  /** Only `readOnly` is used, but the app already has the whole thing. */
  version: { readOnly: boolean } | null;
  /** Whether the app is talking through the server or holding the link itself. */
  source: 'server' | 'direct';
  /**
   * The direct link, when the app is holding one.
   *
   * Structural rather than imported: the device package describes what it needs
   * — read the registers, take a baseline — and the app's richer object
   * satisfies it. That keeps the dependency pointing one way.
   */
  direct: {
    connected: boolean;
    boundId: string | null;
    support: { label: string };
    dump: () => Promise<RegisterDump>;
    snapshot: () => Promise<RegisterDump>;
  };
};

export type StationScreenProps = {
  status: StationStatus | null;
  settings: StationSettings | null;
  /** True when every write is being refused. */
  readOnly: boolean;
  simulated: boolean;
  /** Whether the app is talking through the server or straight to the station. */
  direct: boolean;
  apiBaseUrl: string;
  /** Only shown when a server is in the path; a direct link has none. */
  version?: { version: string; runtime: string; uptimeSeconds: number; readOnly: boolean } | null;
  /** What the app calls the link, e.g. "Bluetooth LE, straight from this browser". */
  linkLabel?: string;
  /** True while the app is still reconnecting to a remembered station. */
  resuming?: boolean;
  updateSettings: (patch: StationSettingsPatch) => Promise<void>;
  togglePort: (id: PortId, enabled: boolean) => Promise<void>;
};
