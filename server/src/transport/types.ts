import type { StationId } from '@kraftverk/plugin-sdk';
import type { DiscoveredDevice, StationLink, StationTransport } from '@kraftverk/protocol';

/**
 * The transport contract lives in `@kraftverk/protocol`, because the app
 * implements it too — over Web Bluetooth in the browser and over
 * react-native-ble-plx on a phone. These aliases keep the server's own
 * transports reading naturally without a second definition to drift.
 */
export type { DiscoveredDevice, StationTransport };

/** What the server itself can carry. The app adds the `direct-*` kinds. */
export type ServerTransportKind = 'mqtt' | 'ble';

/**
 * One station's worth of link, narrowed to what a server can hold.
 *
 * Everything above this — the poll loop, the write whitelist, the decode — is
 * `StationClient`, which never asks what else is out there. That is precisely
 * why a server can hold several of these at once.
 */
export interface ServerLink extends StationLink {
  /** The station this link reaches. Narrower than the app-facing string. */
  readonly boundId: StationId | null;
  readonly kind: ServerTransportKind;
  /** Releases this station. The host and its other links carry on. */
  close(): Promise<void>;
}

/**
 * The radio, or the broker — one per process, carrying many links.
 *
 * The distinction this draws is between the radio and a conversation on it.
 * There is genuinely one host per process — noble owns the adapter, the broker
 * owns its port — and it is the thing that scans. A **link** is not scarce in
 * the same way: a broker serves every station that connects to it, and a BLE
 * central holds several peripherals at once.
 *
 * Keeping them apart is what lets discovery, binding and frame-carrying stop
 * being one object with one `boundId`. What remains scarce is a property of the
 * hardware rather than of this code: a *given* station accepts one connection
 * at a time, so the server competes with the app and with the vendor's own for
 * any single unit.
 */
export interface TransportHost {
  readonly kind: ServerTransportKind;

  start(): Promise<void>;
  stop(): Promise<void>;

  /** Stations seen so far, whether or not anything is linked to them. */
  discovered(): DiscoveredDevice[];
  onDiscovery(listener: (device: DiscoveredDevice) => void): () => void;

  /**
   * Opens a link to one station.
   *
   * Lenient by design: over BLE the peripheral may not be in range yet, and the
   * link's own retry loop is what gets it. A link that is not connected is a
   * normal resting state, not a failure — `connected` says which.
   */
  open(station: StationId): Promise<ServerLink>;

  /** The station ids currently linked, so nothing claims one twice. */
  openIds(): StationId[];
}
