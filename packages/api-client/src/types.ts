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
  /** Which radio this station is reached over. Its own, not the server's. */
  transport: TransportKind | 'sim';
  /** The station it is bound to — a MAC or peripheral id. Null until bound. */
  stationId: string | null;
  connected: boolean;
  /** Why it has no link, when another saved device already holds that station. */
  refusal: string | null;
};

export type StationTransports = {
  /**
   * Every transport this server offers, and whether it came up.
   *
   * Plural because they run together: the MQTT broker is a TCP listener and
   * Bluetooth is a radio, so a server can hold a station on each. A transport
   * that failed to start — no Bluetooth adapter, say — appears here with the
   * reason rather than silently missing.
   */
  transports: { kind: TransportKind | 'sim'; running: boolean; error: string | null }[];
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

/** A station as the MQTT broker sees it — the broker holds its socket, so this is certain. */
export type BrokerStation = {
  station: string;
  online: boolean;
  clientId: string | null;
  /** Where it connected from, `ip:port`. */
  remote: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  /** Why its last session ended, in words. */
  lastDisconnect: string | null;
  lastMessageAt: string | null;
  keepalive: number | null;
  /** Subscribed to its command topic. Without that, commands to it go nowhere. */
  subscribed: boolean;
  sessions: number;
};

/**
 * The MQTT broker, which runs as its own process so that restarting the server
 * does not drop the station.
 */
export type BrokerView = {
  /** `foreign`: the port is held by something that is not a kraftverk broker. */
  status: 'running' | 'starting' | 'down' | 'foreign';
  error: string | null;
  pid: number | null;
  startedAt: string | null;
  build: string | null;
  expectedBuild: string;
  /** False when the running broker is older code than the server's. */
  buildMatches: boolean | null;
  /** Whether this server starts a broker when none runs. False when it is its own service. */
  spawns: boolean;
  listen: { host: string; port: number; listening: boolean };
  /** Whether the server itself is connected to the broker. */
  serverConnected: boolean;
  serverConnectedAt: string | null;
  serverError: string | null;
  stations: BrokerStation[];
};

/** `GET /api/diagnostics/link`, as the server actually sends it. */
export type LinkDiagnostics = {
  driver: LinkMode;
  /** Every transport running on the server. Several can run at once. */
  transports: TransportKind[];
  /** True when the server has a live connection to the MQTT broker. */
  brokerListening: boolean;
  mqtt: { host: string; port: number };
  /** Null when the server does not run the MQTT transport. */
  broker: BrokerView | null;
  devices: BoundableDevice[];
  linkedStations: { deviceId: string; stationId: string | null }[];
  configuredId: string | null;
};

/** One event in the broker's journal. */
/** One line of the server's own log: what its console said, and when. */
export type ServerLogLine = {
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  text: string;
};

export type BrokerJournalEntry = {
  /** Increasing within one broker run; starts again when the broker restarts. */
  seq: number;
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  /** Stable event name: `station.online`, `mqtt.disconnected`, `command`… */
  kind: string;
  /** A sentence that stands on its own. */
  message: string;
  station?: string;
  clientId?: string;
  remote?: string;
  data?: Record<string, unknown>;
};

/** One frame on the broker, in either direction. The broker's record, not the server's. */
export type TrafficEntry = {
  at: string;
  /** `in`: the station said it. `out`: the server sent it. */
  direction: 'in' | 'out';
  mac: string;
  topic: string;
  bytes: number;
  hex: string;
  /** The frame in words: "write holding 26 = 1", "input registers 0+80, reply in 180 ms". */
  summary: string;
  /** False for a command nothing was subscribed to receive. */
  delivered: boolean;
};

/**
 * Extensions.
 *
 * The shapes come from `@kraftverk/device-sdk`, so the setup screen renders
 * from the same declarations the server validates against — that is what lets
 * one screen serve a plugin nobody has written yet.
 */
export type {
  PluginCapability,
  ConfigField,
  ConfigSchema,
  ConfigValues,
  PluginHealth,
  PluginStatus,
  PluginSetupAction,
  SetupActionResult,
  SetupChoice,
} from '@kraftverk/device-sdk';

export type PluginSummary = {
  id: string;
  name: string;
  description: string;
  version: string;
  kind: string;
  icon: string;
  capabilities: import('@kraftverk/device-sdk').PluginCapability[];
  setupActions: import('@kraftverk/device-sdk').PluginSetupAction[];
  status: import('@kraftverk/device-sdk').PluginStatus;
  enabled: boolean;
  health: import('@kraftverk/device-sdk').PluginHealth;
  grants: import('@kraftverk/device-sdk').PluginCapability[];
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
  schema: import('@kraftverk/device-sdk').ConfigSchema;
  values: import('@kraftverk/device-sdk').ConfigValues;
  /** Which secret fields hold a value. Never the values themselves. */
  secretsSet: string[];
  enabled: boolean;
};

export type GridStatus = {
  provider: string | null;
  granted: boolean;
  /**
   * The saved station this relay feeds — what a switch is verified against.
   * Null until paired, and until then every switch is refused.
   */
  stationDeviceId: string | null;
  /** Whether the server holds a live session for that station. */
  stationPresent: boolean;
  state:
    | (import('@kraftverk/device-sdk').RelayState & { provider: string })
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
// The things you own. The descriptor half comes from `@kraftverk/device-sdk`,
// which is what a device package or a plugin writes; only the envelope around
// it — the catalog record and whether the thing is answering — is HTTP.

export type {
  CandidateId,
  ConnectionHealth,
  ConnectionStatus,
  ControlSpec,
  CapabilityName,
  DeviceDescriptor,
  MetricSpec,
  ProviderDeviceId,
  Reading,
  SavedDeviceId,
} from '@kraftverk/device-sdk';
export { isOnline, providerDeviceId, savedDeviceId, stationId, candidateId, sameStation } from '@kraftverk/device-sdk';

export type DeviceRecord = {
  id: string;
  /** A category, for display. Behaviour comes from the device type and its capabilities. */
  type: string;
  /** Unused since models became device types. */
  model: string | null;
  /** How the server files it. Read `SavedDeviceView.typeId` instead. */
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
  import('@kraftverk/device-sdk').DeviceDescriptor,
  'id' | 'name'
> & {
  /** The catalog id: stable, the route segment, and what history is keyed by. */
  id: import('@kraftverk/device-sdk').SavedDeviceId;
  /** Its device type, when an installed one claims it: what decides its screens. */
  typeId: string | null;
  /** The vendor's own identity — a MAC, a Tuya id. Null until known. */
  providerDeviceId: import('@kraftverk/device-sdk').ProviderDeviceId | null;
  /** What the user called it. */
  name: string;
  /** What the vendor calls it, when that is known and differs. */
  providerName: string | null;
  record: DeviceRecord;
  health: import('@kraftverk/device-sdk').ConnectionHealth;
  readings: import('@kraftverk/device-sdk').Reading[];
};

/**
 * Something that can be added: an installed device type, described without its
 * code — or, until the extensions become device types (step 9), an extension
 * that provides a device, which is set up under Extensions rather than by a guide.
 */
export type AddableType = import('@kraftverk/device-sdk').DeviceTypeView & { extension?: true };

export type DeviceTypeList = {
  types: AddableType[];
  /** Packages found and refused, and why: for whoever is writing one. */
  refused: { source: string; problems: string[] }[];
};

export type { DeviceTypeView, DeviceTypeMeta, SetupStepView, SupportLevel } from '@kraftverk/device-sdk';

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
 * describe *this* connection rather than the server as a whole.
 */
export type StationDeviceState = {
  status: import('@kraftverk/protocol').StationStatus;
  settings: import('@kraftverk/protocol').StationSettings;
  readOnly: boolean;
  link: 'sim' | 'mqtt' | 'ble';
};

/** A device's own settings: the schema it declares, and what it holds now. */
export type DeviceSettings = {
  schema: import('@kraftverk/device-sdk').ConfigSchema | null;
  values: import('@kraftverk/device-sdk').ConfigValues;
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

// --- accounts ---------------------------------------------------------------

/** A signed-in account. Every account is an administrator. */
export type Account = { id: string; username: string };

export type AccountDetail = Account & {
  createdAt: string;
  createdBy: string | null;
  lastLoginAt: string | null;
};

/** `GET /api/auth/state`: who this is, from where, and what the app should show. */
export type AuthState = {
  user: Account | null;
  /**
   * This request came from the home network, by the server's rules. Only
   * matters for creating the first account; signing in is required everywhere.
   */
  onHomeNetwork: boolean;
  /** Why the server decided what it did about the network, in words. */
  reason: string;
  /** No accounts exist yet. */
  setupRequired: boolean;
  /** No accounts exist, and this device may create the first. */
  canSetup: boolean;
};
