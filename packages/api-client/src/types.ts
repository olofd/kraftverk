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

/** A station this radio noticed, as `/api/station/transports` reports it. */
export type BoundableDevice = DiscoveredDevice & { bound: boolean };

/**
 * What the current transport can see, and which station it is bound to.
 *
 * Not the device list. These are peripherals a radio happened to notice; a
 * *device* is something you own and named, and it stays in the catalog when no
 * radio can see it. The server draws the same line — this is `/station/…`, and
 * `/devices` belongs to the catalog.
 */
export type StationTransports = {
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

// --- devices ----------------------------------------------------------------
//
// The things you own. The descriptor half comes from `@kraftverk/plugin-sdk`,
// which is what a device package or a plugin writes; only the envelope around
// it — the catalog record and whether the thing is answering — is HTTP.

export type {
  ControlSpec,
  DeviceDescriptor,
  DeviceKind,
  MeasurementSpec,
  Reading,
} from '@kraftverk/plugin-sdk';

export type DeviceRecord = {
  id: string;
  type: 'power-station' | 'smart-plug';
  /** Which hardware it is. Decides how it is read. */
  model: string | null;
  /** `core.station`, or a plugin id. */
  driver: string;
  name: string;
  config: Record<string, unknown>;
  addedAt: string;
};

/**
 * A device as the app sees it: what it is, plus what it is doing right now.
 *
 * `online: false` is a normal resting state, not an error — the catalog outlives
 * the radio. A device that is unplugged keeps its card, its name and its
 * history, and says why it isn't answering.
 */
export type DeviceView = import('@kraftverk/plugin-sdk').DeviceDescriptor & {
  /** The catalog id: stable, and what history is keyed by. */
  id: string;
  record: DeviceRecord;
  online: boolean;
  /** Why not, when it isn't. */
  detail?: string;
  readings: import('@kraftverk/plugin-sdk').Reading[];
};

/** A model of a device type, and how far it is actually trusted. */
export type DeviceModelOption = {
  id: string;
  label: string;
  verified: boolean;
  note: string;
};

/** What can be added, and what each one needs. Drives the add-device flow. */
export type DeviceTypeOption = {
  id: string;
  label: string;
  description: string;
  icon: string;
  driver: string;
  models: DeviceModelOption[];
  available: boolean;
  note?: string;
};

/** A device's own settings: the schema it declares, and what it holds now. */
export type DeviceSettings = {
  schema: import('@kraftverk/plugin-sdk').ConfigSchema | null;
  values: import('@kraftverk/plugin-sdk').ConfigValues;
  /** Settings that can damage the hardware if set wrongly. */
  dangerous: string[];
};

export type SeriesPoint = { at: string; value: number };

export type DeviceHistory = {
  deviceId: string;
  key: string;
  from: string;
  to: string;
  points: SeriesPoint[];
};
