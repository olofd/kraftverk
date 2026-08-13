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

/**
 * Extensions.
 *
 * The shapes come from `@kraftverk/plugin-sdk`, so the setup screen renders
 * from the same declarations the server validates against — that is what lets
 * one screen serve a plugin nobody has written yet.
 */
export type {
  CapabilityName,
  ConfigField,
  ConfigSchema,
  ConfigValues,
  PluginHealth,
  PluginStatus,
  SetupAction,
  SetupActionResult,
  SetupChoice,
} from '@kraftverk/plugin-sdk';

export type PluginSummary = {
  id: string;
  name: string;
  description: string;
  version: string;
  kind: string;
  icon: string;
  capabilities: import('@kraftverk/plugin-sdk').CapabilityName[];
  setupActions: import('@kraftverk/plugin-sdk').SetupAction[];
  status: import('@kraftverk/plugin-sdk').PluginStatus;
  enabled: boolean;
  health: import('@kraftverk/plugin-sdk').PluginHealth;
  grants: import('@kraftverk/plugin-sdk').CapabilityName[];
  error: string | null;
};

export type PluginList = {
  /** False when secrets are stored unencrypted, which the UI must not hide. */
  secretsEncrypted: boolean;
  activeProviders: { gridRelay: string | null };
  plugins: PluginSummary[];
};

export type PluginConfig = {
  id: string;
  schema: import('@kraftverk/plugin-sdk').ConfigSchema;
  values: import('@kraftverk/plugin-sdk').ConfigValues;
  /** Which secret fields hold a value. Never the values themselves. */
  secretsSet: string[];
  enabled: boolean;
};

export type GridStatus = {
  provider: string | null;
  granted: boolean;
  state:
    | (import('@kraftverk/plugin-sdk').RelayState & { provider: string })
    | null;
};

export type RelayCommandResult = {
  outcome: 'verified' | 'unverified' | 'refused' | 'failed';
  detail: string;
  relayReported?: boolean;
  stationAgreed?: boolean;
};
