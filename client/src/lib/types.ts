import type { DiscoveredDevice, LinkMode, TransportKind } from '@kraftverk/protocol';

/**
 * The station's shape comes from `@kraftverk/protocol`, the same package the
 * server decodes with — and the same one this app runs directly when it talks
 * to a station over Bluetooth itself. There is no second copy to drift.
 *
 * What is declared here is the server's HTTP surface: the envelopes around
 * those shapes, which only exist when there is a server in the middle.
 */
export type {
  DiscoveredDevice,
  FirmwareVersions,
  RegisterDump,
  RegisterRow,
  LedMode,
  LinkMode,
  LinkState,
  PortId,
  PortState,
  StationSettings,
  StationSettingsPatch,
  StationState,
  StationStatus,
  TransportKind,
  VersionInfo,
} from '@kraftverk/protocol';

/** A discovered device as `/api/devices` reports it: bound or not. */
export type BoundableDevice = DiscoveredDevice & { bound: boolean };

export type DeviceList = {
  transport: TransportKind | null;
  boundId: string | null;
  connected: boolean;
  autoBind: boolean;
  /** BLE only: why the last connect attempt failed, and how many were made. */
  lastError: string | null;
  attempts: number | null;
  devices: BoundableDevice[];
};

/** `GET /api/diagnostics/link`, as the server actually sends it. */
export type LinkDiagnostics = {
  driver: LinkMode;
  transport: TransportKind | null;
  brokerListening: boolean;
  mqtt: { host: string; port: number };
  devices: BoundableDevice[];
  boundId: string | null;
  connected: boolean;
  configuredId: string | null;
};

export type TrafficEntry = {
  at: string;
  mac: string;
  topic: string;
  bytes: number;
  hex: string;
};
