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
/** One saved station and the link it holds, named by its catalog id. */
export type StationLinkView = {
  deviceId: string;
  name: string;
  /** The station it is bound to — a MAC or peripheral id. Null until bound. */
  stationId: string | null;
  connected: boolean;
  /** Why it has no link, when another saved device already holds that station. */
  refusal: string | null;
};

export type StationTransports = {
  transport: TransportKind | null;
  autoBind: boolean;
  /** BLE only: why the last connect attempt failed, and how many were made. */
  lastError: string | null;
  attempts: number | null;
  /**
   * Every saved station and the link it holds. Empty on the simulator.
   *
   * There is deliberately no top-level `boundId`/`connected`. They described
   * whichever session was first, which is a fact about nothing — a screen
   * rendering them shows one station's state under a heading that implies it is
   * the only one.
   */
  links: StationLinkView[];
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
  CandidateId,
  ConnectionHealth,
  ConnectionStatus,
  ControlSpec,
  DeviceDescriptor,
  DeviceKind,
  MeasurementSpec,
  ProviderDeviceId,
  Reading,
  SavedDeviceId,
} from '@kraftverk/plugin-sdk';
export { isOnline, providerDeviceId, savedDeviceId, stationId, candidateId, sameStation } from '@kraftverk/plugin-sdk';

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
 * A saved device as the app sees it: what it is, plus what it is doing now.
 *
 * `health.status` is not a boolean, and deliberately so — the catalog outlives
 * the radio, and "unplugged", "still connecting", "never finished setting up"
 * and "the key is wrong" ask four different things of the user. Every one of
 * them carries a sentence, so a quiet card can always say why.
 *
 * The descriptor is spread in without its `id` and `name`: those two belong to
 * the catalog here, and the vendor's are `providerDeviceId` and `providerName`.
 */
export type SavedDeviceView = Omit<
  import('@kraftverk/plugin-sdk').DeviceDescriptor,
  'id' | 'name'
> & {
  /** The catalog id: stable, the route segment, and what history is keyed by. */
  id: import('@kraftverk/plugin-sdk').SavedDeviceId;
  /** The adapter's own identity — a MAC, a Tuya id. Null before commissioning. */
  providerDeviceId: import('@kraftverk/plugin-sdk').ProviderDeviceId | null;
  /** What the user called it. */
  name: string;
  /** What the vendor calls it, when that is known and differs. */
  providerName: string | null;
  record: DeviceRecord;
  health: import('@kraftverk/plugin-sdk').ConnectionHealth;
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

/**
 * A station bound before the device catalog existed.
 *
 * The server no longer adopts a station it happens to be talking to, so a
 * previous installation's binding is offered as an import instead — once, and
 * only when the server is running the transport the binding names.
 */
export type LegacyStationOffer = {
  state: 'none' | 'offered' | 'imported' | 'dismissed';
  transport: 'mqtt' | 'ble' | null;
  boundId: string | null;
  boundAt: string | null;
  name: string | null;
};

/**
 * Everything a P280's own screens need, for one saved device.
 *
 * The station's telemetry does not fit the generic `Reading[]` shape — the
 * energy-flow view needs ports, firmware and link state in the model's own
 * units — so it has a device-scoped route of its own. `readOnly` and `link`
 * describe *this* connection, which used to be read off a global version
 * endpoint that described the whole server.
 */
export type StationDeviceState = {
  status: import('@kraftverk/protocol').StationStatus;
  settings: import('@kraftverk/protocol').StationSettings;
  readOnly: boolean;
  link: 'sim' | 'mqtt' | 'ble';
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
