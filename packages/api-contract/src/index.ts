/**
 * The server's HTTP surface, as shapes — declared once, here.
 *
 * The server builds these and the app reads them, and both import them from
 * this package, so a field changed on one side fails the typecheck on the
 * other instead of failing on a phone. Types only: the server validates what
 * it receives with its own schemas, typed against the inputs declared here.
 *
 * What a device *is* — its type, its description (parts, attributes, events),
 * its setup steps — is declared in `@kraftverk/device-sdk` and re-exported
 * from here. What is
 * declared here is only the envelope the server wraps around it: a saved
 * device with its connections and links, a setup draft, a transport as this
 * server runs it. No device type is named.
 */

import type {
  AutomationId,
  Availability,
  CapabilityId,
  CapabilityName,
  CategorySpec,
  ClientId,
  ConfigSchema,
  ConfigValues,
  ConnectionHealth,
  ConnectionId,
  DescriptionSource,
  DeviceDescription,
  DeviceInfo,
  DeviceTypeMeta,
  DeviceTypeView,
  EventLevel,
  LinkEnd,
  LinkId,
  LinkKind,
  Reading,
  AuditSubject,
  PolicyValueName,
  PolicyValueSpec,
  ResourceKind,
  SavedDeviceId,
  SetupStepView,
  ToolSpec,
  TransportDefinition,
  Value,
} from '@kraftverk/device-sdk';

export type {
  AuditSubject,
  PolicyValueName,
  PolicyValueSpec,
  AutomationId,
  Availability,
  CapabilityId,
  CapabilityName,
  ClientId,
  ConnectionId,
  LinkEnd,
  LinkId,
  Reach,
  ResourceKind,
  ToolSpec,
  CategoryId,
  CategorySpec,
  ConfigField,
  ConfigSchema,
  ConfigValues,
  ConnectionHealth,
  ConnectionMethodView,
  ConnectionStatus,
  AttributeSpec,
  DescriptionSource,
  DeviceDescription,
  DeviceInfo,
  DeviceTypeMeta,
  DeviceTypeView,
  LinkKind,
  Part,
  Reading,
  SavedDeviceId,
  SetupActionResult,
  SetupChoice,
  SetupStepView,
  SupportLevel,
  TransportDefinition,
  Value,
} from '@kraftverk/device-sdk';
export type { GatewayResult, GatewayOutcome, WriteResult } from '@kraftverk/gateway';

/** `GET /api/version`. */
export type VersionInfo = {
  name: string;
  version: string;
  runtime: string;
  startedAt: string;
  uptimeSeconds: number;
  /** Every write to hardware is refused. */
  readOnly: boolean;
};

// --- devices ------------------------------------------------------------------

/** One way a device is reached, as its page lists it. */
export type ConnectionView = {
  id: ConnectionId;
  method: string;
  /** "Wi-Fi", from the type. */
  methodLabel: string;
  transport: string;
  /** Who holds it: the server, or one phone or browser. */
  heldBy: { kind: 'server' } | { kind: 'client'; id: ClientId; name: string };
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

/** A link as one of its devices' pages lists it: which of its parts, and which part of which other device. */
export type LinkView = {
  id: LinkId;
  kind: LinkKind;
  /** Whether this device is the link's source or its target. */
  role: 'source' | 'target';
  /** The part of this device the link joins. */
  part: string;
  other: { id: SavedDeviceId; name: string; part: string; partLabel: string };
};

/** A tool of the device's type that its session can run now, as data. */
export type ToolView = ToolSpec & { name: string };

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
  /** What it is: its parts, their attributes — settings among them — and its events. Its own when it reports one. */
  description: DeviceDescription;
  /** Whose word that is: its type's, for its config, or the device's own — which can change while it runs (a pack plugged in). */
  descriptionSource: DescriptionSource;
  /** Every capability any of its parts offers. */
  capabilities: readonly CapabilityId[];
  /** What it has said about itself: firmware, serial. */
  info: DeviceInfo | null;
  config: Record<string, unknown>;
  connections: ConnectionView[];
  links: LinkView[];
  /** The tools of its type its session can run now: what each asks for, what it answers, and whether it changes the device. */
  tools: ToolView[];
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

/**
 * `PATCH /devices/:id/attributes`: only what should change, of the attributes
 * its description says can be written. A dangerous one needs `confirmation`: the
 * token the refusal's `needsConfirmation` handed out, once a person said yes. The
 * answer is the gateway's verdict either way, with what the device reports
 * afterwards.
 */
export type AttributeWrite = { patch: Record<string, Value>; confirmation?: string };

/** `POST /devices/:id/parts/:part/commands/:capability/:command`. */
export type CommandBody = { args: Record<string, Value>; reason?: string; confirmation?: string };

export type SeriesPoint = { at: string; value: number };

export type DeviceHistory = {
  deviceId: string;
  key: string;
  from: string;
  to: string;
  /** Minute samples for a short span; hourly means, kept for two years, for a long one. */
  resolution: 'minute' | 'hour';
  points: SeriesPoint[];
};

/** One change of an on/off or an enum: from this moment, it was this. */
export type DeviceChange = { key: string; part: string; at: string; value: Value };

/**
 * `GET /devices/:id/changes?from&to&key`: every change in the span, oldest
 * first, with each key's value from before it began — so "off 14:02–14:19"
 * can be drawn from the first row on.
 */
export type DeviceChanges = { deviceId: string; from: string; to: string; changes: DeviceChange[] };

/** A fact about the house between two parts: this plug's relay feeds that station's mains input. */
export type LinkRecord = { id: LinkId; kind: LinkKind; source: LinkEnd<SavedDeviceId>; target: LinkEnd<SavedDeviceId>; createdAt: string };

/** `POST /links`. */
export type NewLink = { kind: LinkKind; source: LinkEnd<string>; target: LinkEnd<string> };

// --- the assistant ------------------------------------------------------------------

/** One value a part reports, as the world snapshot says it: what it means, what it is, and whether it is current. */
export type WorldValue = {
  key: string;
  label: string;
  /** Its meaning in the shared vocabulary, or a type's own: `battery.soc`. */
  means: string | null;
  value: Value;
  unit: string | null;
  /** Seconds since the device observed it; null when it has never said. */
  age: number | null;
  /** Still current for its attribute: a stale value is known, but not to be acted on. */
  current: boolean;
};

export type WorldPart = { id: string; label: string; kind: string; capabilities: CapabilityId[]; values: WorldValue[] };

export type WorldDevice = {
  id: SavedDeviceId;
  name: string;
  type: string;
  kind: 'hardware' | 'service';
  status: ConnectionHealth['status'];
  detail: string;
  parts: WorldPart[];
  /** Facts about the house from this device's parts: "outlet.ac feeds Cabin station input.ac". */
  links: { kind: LinkKind; part: string; role: 'source' | 'target'; device: SavedDeviceId; name: string; otherPart: string }[];
};

/**
 * `GET /world`: the house as a model reads it — every device, its parts and
 * what each offers and reports, with freshness, and the links between them.
 * Typed and small, in a stable order. `?format=text` is the same, a few lines
 * a device, for a context window.
 */
export type WorldView = {
  at: string;
  /** Every write is refused: the server is read-only. */
  readOnly: boolean;
  /** What an assistant may do, in a sentence per rule: what the gateway will hold it to. */
  rules: string[];
  devices: WorldDevice[];
};

/**
 * `GET /vocabulary`: the words the world is said in — capabilities with their
 * commands, queries and what makes a command consequential; meanings with
 * their units; link kinds; the recipes an automation can be made from, and
 * the values the home has set.
 */
export type VocabularyView = {
  capabilities: Record<string, { label: string; attributes: Record<string, string>; commands: Record<string, { description: string; args: Record<string, unknown>; consequential: unknown }>; queries: Record<string, { description: string; args: Record<string, unknown> }> }>;
  meanings: Record<string, { label: string; type: 'number' | 'boolean'; unit: string | null }>;
  links: Record<string, { verb: string; from: string; to: string; description: string }>;
  recipes: { id: string; label: string; description: string; roles: Record<string, { label: string; capabilities: readonly string[]; oneOf?: readonly string[] }>; params: ConfigSchema }[];
  policy: Record<string, { label: string; value: number; unit: string }>;
};

/** What rehearsing a rule on what happened found: when it would have run, and what it would have done. */
export type Rehearsal = {
  from: string;
  to: string;
  /** Oldest first. */
  runs: { at: string; outcome: 'would-act' | 'idle' | 'unknown'; summary: string }[];
  /** What the rehearsal could not see: a function history does not keep, a device with no history. */
  caveats: string[];
};

// --- events -----------------------------------------------------------------------

/** Something a device said happened, as it is kept: `GET /devices/:id/events`, newest first. */
export type DeviceEventView = {
  id: number;
  deviceId: SavedDeviceId;
  part: string;
  /** The event's id, as its description declares it: `mains.lost`. */
  event: string;
  level: EventLevel;
  data: Readonly<Record<string, Value>> | null;
  at: string;
};

/** `GET /problems`: warnings and errors across the devices you have, newest first, each with its device's name. */
export type ProblemView = DeviceEventView & { deviceName: string };

// --- live -------------------------------------------------------------------------

/** Something a device said happened, as the live stream carries it. */
export type LiveEvent = {
  id: string;
  level: EventLevel;
  part: string | null;
  data: Readonly<Record<string, Value>> | null;
  at: string;
};

/**
 * `GET /api/live`, a WebSocket: what changed, as it changes, server to app.
 *
 * The app reads the list (`GET /devices`) when the socket opens, and applies
 * these on top: readings merged by key, health replaced. `changed` asks it to
 * read the list again — something it does not carry in detail changed: a
 * device added, renamed or removed, a connection, a link, what a device is.
 * When the socket is down the app polls, as it did before there was one.
 */
export type LiveUpdate =
  | { type: 'hello'; at: string }
  /** Only the readings whose values moved. */
  | { type: 'readings'; deviceId: SavedDeviceId; readings: Reading[] }
  | { type: 'health'; deviceId: SavedDeviceId; health: ConnectionHealth }
  | { type: 'event'; deviceId: SavedDeviceId; event: LiveEvent }
  | { type: 'changed'; deviceId: SavedDeviceId | null };

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

/** `POST /setup/:id/save`, as sent: the name may be empty (the type's name is used) and `mode` defaults to `new`. */
export type SaveInput = {
  name?: string;
  /** Add a new device; attach this connection to one you have; or bring a removed one back. */
  mode?: 'new' | 'attach' | 'restore';
  deviceId?: string;
  /** Save after a check the type expects to fail sometimes: a sleeping station. */
  anyway?: boolean;
  /** Links from or to the device being saved: which of its parts, and which part of a device you have. */
  links?: { kind: LinkKind; part: string; other: LinkEnd<string>; role: 'source' | 'target' }[];
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
  running: boolean;
  availability: Availability;
  values: Record<string, string>;
  /** Names of its read-only diagnostics. */
  diagnostics: string[];
};

export type TransportList = {
  readOnly: boolean;
  transports: TransportView[];
  refused: Refused[];
};

/** A phone or browser running the app, as the server knows it. */
export type ClientRecord = {
  id: ClientId;
  userId: string;
  name: string;
  platform: 'web' | 'native';
  transports: string[];
  createdAt: string;
  lastSeenAt: string;
};

/** One line of the server's own log. */
export type ServerLogLine = { at: string; level: 'debug' | 'info' | 'warn' | 'error'; text: string };

/** A line an app sends for the timeline: the server adds who sent it. */
export type AuditUpload = { at: string; kind: string; summary: string; detail?: unknown } & AuditSubject;

/** One line of the timeline: who did what, to what, and what came of it. */
export type AuditEntry = {
  id: number;
  at: string;
  kind: string;
  actor: string;
  /** What it is about — a device, an app, an automation, an account — or nothing. */
  resourceKind: ResourceKind | null;
  resource: string | null;
  summary: string;
  detail?: unknown;
};

/**
 * `GET /policy`: a number this home decides that declarations name — how much
 * is a load worth confirming — with what it is now and what it would be unset.
 * `PUT /policy/:name` with `{ value }` sets it; `null` puts it back.
 */
export type PolicyValueView = PolicyValueSpec & { name: PolicyValueName; value: number };

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
// --- automations ----------------------------------------------------------------

/** Which part of which device fills a role: a plug, or one of a station's outlets. */
export type RoleBinding = { device: SavedDeviceId; part: string };

/**
 * A recipe the server offers: roles to fill with parts of devices, and its
 * settings. Recipes come with the installed packages (docs/AUTOMATIONS.md);
 * `from` says which.
 */
export type RecipeView = {
  /** Namespaced by the type it came with: `acme.weather.forecast-switch`. */
  id: string;
  label: string;
  description: string;
  /** The package it came with; null for the shared vocabulary's own. */
  from: { typeId: string; name: string } | null;
  /** What each role asks of a part: every one of `capabilities`, and one of `oneOf` when given. */
  roles: Record<
    string,
    {
      label: string;
      description: string;
      capabilities: readonly CapabilityName[];
      oneOf?: readonly CapabilityName[];
    }
  >;
  params: ConfigSchema;
};

/** `POST /automations`. `timeZone` is the app's own clock: "Europe/Stockholm". */
export type NewAutomation = { name: string; recipe: string; roles: Record<string, RoleBinding>; params: ConfigValues; timeZone: string };

/** `PATCH /automations/:id`. Arming, or changing an armed one, needs `confirmation`. */
export type AutomationChanges = {
  name?: string;
  roles?: Record<string, RoleBinding>;
  params?: ConfigValues;
  timeZone?: string;
  mode?: AutomationMode;
  confirmation?: string;
};

/** off: nothing; observe: decides and says what it would have done; armed: acts, through the gateway. */
export type AutomationMode = 'off' | 'observe' | 'armed';

export type AutomationRun = {
  at: string;
  outcome:
    | 'acted' // the gateway carried it out, verified
    | 'unverified' // the gateway sent it, but the effect is not proven
    | 'would-act' // observing: it would have acted
    | 'idle' // the condition was not met
    | 'unknown' // it could not tell
    | 'refused' // the gateway said no
    | 'failed'; // the command errored
  summary: string;
};

export type AutomationView = {
  id: AutomationId;
  name: string;
  recipe: string;
  recipeLabel: string;
  /** What it does, in a sentence: "At 07:00, if tomorrow looks sunny by Weather, turn Heater plug on." */
  sentence: string;
  roles: Record<string, RoleBinding>;
  params: ConfigValues;
  timeZone: string;
  mode: AutomationMode;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastResult: AutomationRun | null;
  /** Why it cannot run as it is: a removed device. Empty when it can. */
  problems: string[];
};
