/**
 * The server's HTTP surface, as shapes.
 *
 * What a device *is* — its type, capabilities, telemetry, setup steps — is
 * declared in `@kraftverk/device-sdk`, which the server and every package share,
 * and re-exported from here. What is declared here is only the envelope the
 * server wraps around it: a saved device with its connections and links, a
 * setup draft, a transport as this server runs it. No device type is named.
 */

import type {
  Availability,
  CapabilityName,
  CategorySpec,
  ConfigSchema,
  ConfigValues,
  ConnectionHealth,
  ControlSpec,
  DeviceTypeMeta,
  DeviceTypeView,
  MetricSpec,
  Reading,
  SavedDeviceId,
  SettingsSpec,
  SetupStepView,
  TransportDefinition,
} from '@kraftverk/device-sdk';

export type {
  Availability,
  CapabilityName,
  CategoryId,
  CategorySpec,
  ConfigField,
  ConfigSchema,
  ConfigValues,
  ConnectionHealth,
  ConnectionMethodView,
  ConnectionStatus,
  ControlSpec,
  DeviceTypeMeta,
  DeviceTypeView,
  LinkKind,
  MetricSpec,
  Reading,
  SavedDeviceId,
  SettingsSpec,
  SetupActionResult,
  SetupChoice,
  SetupStepView,
  SupportLevel,
  TransportDefinition,
} from '@kraftverk/device-sdk';
export { CATEGORIES, isOnline, LINK_KINDS, savedDeviceId } from '@kraftverk/device-sdk';
export type { GatewayResult, GatewayOutcome } from '@kraftverk/gateway';

/** `GET /api/version`. */
export type VersionInfo = {
  name: string;
  version: string;
  runtime: string;
  startedAt: string;
  uptimeSeconds: number;
  /** Every device is simulated: this server reaches no hardware. */
  simulate: boolean;
  /** Which transports this server may use. */
  transports: string[];
  readOnly: boolean;
};

// --- devices ------------------------------------------------------------------

/** One way a device is reached, as its page lists it. */
export type ConnectionView = {
  id: string;
  method: string;
  /** "Wi-Fi", from the type. */
  methodLabel: string;
  transport: string;
  /** Who holds it: the server, or one phone or browser. */
  heldBy: { kind: 'server' } | { kind: 'client'; id: string; name: string };
  address: string;
  priority: number;
  /** Whether it reaches the device right now; null when nobody is trying it. */
  reachable: boolean | null;
  /** The one the device is using right now: the reachable one highest in the list. */
  inUse: boolean;
  lastConnectedAt: string | null;
  /** Which secrets it has, by field — never their values. */
  secrets: string[];
  config: Record<string, unknown>;
};

export type LinkView = {
  id: string;
  kind: string;
  /** Whether this device is the link's source or its target. */
  role: 'source' | 'target';
  other: { id: SavedDeviceId; name: string };
};

/** A saved device, joined to what it is doing right now. */
export type DeviceView = {
  id: SavedDeviceId;
  typeId: string;
  /** Whether an installed type claims it. */
  installed: boolean;
  name: string;
  identity: string | null;
  addedAt: string;
  removedAt: string | null;
  kind: 'hardware' | 'service';
  meta: Pick<DeviceTypeMeta, 'name' | 'brand' | 'icon' | 'support'> & { category: string };
  capabilities: readonly CapabilityName[];
  measurements: readonly MetricSpec[];
  controls: readonly ControlSpec[];
  settings: SettingsSpec | null;
  config: Record<string, unknown>;
  connections: ConnectionView[];
  links: LinkView[];
  /** The type's own tools, by name, and which of them change the device. */
  advanced: { name: string; writes: boolean }[];
  readings: Reading[];
  health: ConnectionHealth;
};

/** An installed type, and whether this server can hold a connection over each of its methods. */
export type DeviceTypeListing = DeviceTypeView & {
  availability: Record<string, { server: Availability }>;
  warnings: readonly string[];
};

export type Refused = { source: string; problems: string[] };

/** `GET /api/device-types`. */
export type DeviceTypeList = {
  categories: Record<string, CategorySpec>;
  types: DeviceTypeListing[];
  transports: TransportDefinition[];
  refused: { types: Refused[]; protocols: Refused[]; transports: Refused[] };
};

/** A device's own settings: the schema it declares, and what it holds now. */
export type DeviceSettings = {
  schema: ConfigSchema | null;
  values: ConfigValues;
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

export type LinkRecord = { id: string; kind: string; sourceId: SavedDeviceId; targetId: SavedDeviceId; createdAt: string };

// --- adding a device ----------------------------------------------------------

/** What the check step found. */
export type CheckOutcome =
  | { outcome: 'new'; summary: string; identity: string | null }
  | { outcome: 'yours'; summary: string; device: { id: SavedDeviceId; name: string } }
  | { outcome: 'removed'; summary: string; identity: string; devices: { id: SavedDeviceId; name: string; removedAt: string }[] }
  | { outcome: 'other-model'; summary: string; model: string; type: { id: string; name: string } | null }
  | { outcome: 'no-answer'; summary: string; saveAnyway: string | null };

/** Something a transport can see that this type's protocol recognises. */
export type SightingView = {
  address: string;
  name: string;
  detail: string | null;
  identity: string | null;
  seenAt: string;
  rssi: number | null;
  /** A device you already have is reached at this address. */
  claimedBy: { id: SavedDeviceId; name: string } | null;
};

/** One setup, part-way through, on the server. */
export type DraftView = {
  id: string;
  /** Null when the server will hold the connection; otherwise the app that will. */
  heldBy: string | null;
  typeId: string;
  methodId: string | null;
  plan: SetupStepView[];
  address: string | null;
  device: Record<string, unknown>;
  connection: Record<string, unknown>;
  /** Secret fields held so far, by name. */
  secrets: string[];
  checked: CheckOutcome | null;
  expiresAt: string;
};

export type SaveInput = {
  name: string;
  mode?: 'new' | 'attach' | 'restore';
  deviceId?: string;
  anyway?: boolean;
  links?: { kind: string; other: string; role: 'source' | 'target' }[];
};

/** What an app learnt by reading a device itself, for a connection it will hold. */
export type HeldSetupInput = {
  clientId: string;
  typeId: string;
  methodId: string;
  address: string;
  identified: { identity: string | null; model: string | null; name?: string; summary: string; config?: ConfigValues } | null;
  failure?: string;
  device?: ConfigValues;
  connection?: ConfigValues;
};

/** "Found near you": something a transport sees that nothing you have is reached by. */
export type FoundView = {
  transport: string;
  protocol: string;
  address: string;
  name: string;
  detail: string | null;
  identity: string | null;
  model: string | null;
  seenAt: string;
  types: { typeId: string; methodId: string; name: string; category: string }[];
};

// --- transports, apps, the server ---------------------------------------------

export type TransportView = TransportDefinition & {
  enabled: boolean;
  running: boolean;
  availability: Availability;
  values: Record<string, string>;
  /** Names of its read-only diagnostics. */
  diagnostics: string[];
};

export type TransportList = {
  simulate: boolean;
  readOnly: boolean;
  transports: TransportView[];
  refused: Refused[];
};

/** A phone or browser running the app, as the server knows it. */
export type ClientRecord = {
  id: string;
  userId: string;
  name: string;
  platform: 'web' | 'native';
  transports: string[];
  createdAt: string;
  lastSeenAt: string;
};

/** One line of the server's own log. */
export type ServerLogLine = { at: string; level: 'debug' | 'info' | 'warn' | 'error'; text: string };

export type AuditEntry = {
  id?: number;
  at: string;
  kind: string;
  actor: string;
  resource?: string | null;
  summary: string;
  detail?: unknown;
};

// --- accounts -----------------------------------------------------------------

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
  onHomeNetwork: boolean;
  reason: string;
  setupRequired: boolean;
  canSetup: boolean;
};
export { CONFIRMATION as CONFIRMATION_TOKEN } from '@kraftverk/gateway';
