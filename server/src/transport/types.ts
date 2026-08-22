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
 * This is the distinction the old `Transport` interface did not draw, and the
 * reason the server could only ever hold one station. Discovery, binding and
 * frame-carrying were a single object with a single `boundId`, so a second
 * station had nowhere to go: over MQTT its frames were read off the broker and
 * then dropped on the floor by an identity check, and over BLE its connection
 * would have overwritten the first one's characteristics.
 *
 * There genuinely is only one of *this* per process — noble owns the adapter,
 * and the broker owns its port. What there is not is only one **link**. A
 * broker serves every station that connects to it; a BLE central can hold
 * several peripherals at once. What remains true, and is a property of the
 * hardware rather than of this code, is that a *given* station accepts one
 * connection at a time — so the server still competes with the app and with the
 * vendor's own for any single unit.
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
