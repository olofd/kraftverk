import type { DiscoveredDevice, StationTransport } from '@kraftverk/protocol';

/**
 * The transport contract lives in `@kraftverk/protocol`, because the app
 * implements it too — over Web Bluetooth in the browser and over
 * react-native-ble-plx on a phone. These aliases keep the server's own
 * transports reading naturally without a second definition to drift.
 */
export type { DiscoveredDevice };

/** What the server itself can carry. The app adds the `direct-*` kinds. */
export type ServerTransportKind = 'mqtt' | 'ble';

/**
 * The shared contract, narrowed to the two links a server can hold. Keeping
 * `kind` narrow is what lets a saved binding record which transport it belongs
 * to without having to handle transports only the app can open.
 */
export interface Transport extends StationTransport {
  readonly kind: ServerTransportKind;
}
