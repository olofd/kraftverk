/**
 * The server's HTTP surface, as shapes — declared once, here.
 *
 * The server builds these and the app reads them, and both import them from
 * this package, so a field changed on one side fails the typecheck on the
 * other instead of failing on a phone. Types, and `ApiError` — a refusal in
 * words, whichever way a home is reached (`error.ts`). The server validates
 * what it receives with its own schemas, typed against the inputs declared
 * here.
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
  EnumOption,
  EventLevel,
  LinkEnd,
  LinkId,
  LinkKind,
  Reading,
  AuditSubject,
  PolicyValueName,
  PolicyValueSpec,
  Quantity,
  ResourceKind,
  SavedDeviceId,
  SetupStepView,
  ToolSpec,
  TransportDefinition,
  Value,
  ValueType,
} from '@kraftverk/device-sdk';
import type { Rule, StepKind, StepLine } from '@kraftverk/automation';
import type { GatewayResult, WriteResult } from '@kraftverk/gateway';

export { ApiError, API_ERROR_STATUS, type ApiErrorKind } from './error.ts';

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
  SetupActionView,
  SetupChoice,
  SetupStepView,
  SetupWaiting,
  SupportLevel,
  TransportDefinition,
  Value,
} from '@kraftverk/device-sdk';
export type { StepKind, StepLine, Rule, RoleSpec, Step, Expr, Trigger, Weekday, CompareOp, Command } from '@kraftverk/automation';
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
  /** Whether its secrets may leave in an export as plain text: its owner's choice, off unless chosen (docs/CONFIG.md). */
  secretsExportable: boolean;
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
  /** Its name in configuration: what a file and an import know it by (docs/CONFIG.md). */
  key: string;
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
  /** Which picture it shows: its owner's pick, else its type's first (`type:0`). */
  picture: PictureRef;
};

/**
 * A picture of a device, by where it comes from:
 *
 * - `type:N` — its type's Nth picture, counting from 0: from its package
 *   (`kraftverk.assets.images`), shipped with the app. One no longer there is
 *   shown as the first.
 * - `own:<id>` — reserved for a photo its owner takes of it: stored and served
 *   by the server, at `/devices/:id/pictures/<id>`. Not built yet; nothing
 *   else about a device changes when it is.
 */
export type PictureRef = `type:${number}` | `own:${string}`;

/** `PUT /devices/:id/picture`: which picture to show. */
export type PictureChoice = { picture: PictureRef };

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

/**
 * `POST /devices/:id/tools/:name`, for a tool that writes. One that says what
 * it cannot undo is refused first with 409 `{ error, needsConfirmation }`: the
 * token for a person's yes, presented here as `confirmation`.
 */
export type ToolBody = { input?: Record<string, Value>; confirmation?: string };

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
  recipes: { id: string; label: string; description: string; roles: Record<string, { label: string; capabilities: readonly string[]; oneOf?: readonly string[] } | { label: string; automation: true }>; params: ConfigSchema }[];
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
  | { type: 'changed'; deviceId: SavedDeviceId | null }
  /** An automation moved: a run started, took a step, or ended. Read it again. */
  | { type: 'automation'; id: AutomationId };

/** Something a screen shows: a device, an automation. More kinds as screens show more. */
export type ShownThing = { kind: 'device'; id: SavedDeviceId } | { kind: 'automation'; id: AutomationId };

/**
 * What an app says over `GET /api/live`, app to server: what it shows now.
 *
 * A fact, not a request — the server judges what follows from it: a device
 * someone is looking at is read more often. Said when the screen changes,
 * again each time the stream opens, and at most once a minute while someone
 * uses the app; an app that says nothing for ten minutes is taken for
 * unattended. `screen` names the screen (`device`, `home`), not the address.
 */
export type ViewReport = { type: 'view'; screen: string; showing: ShownThing[] };

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
  /** Whether the connection's secrets may leave in an export as plain text: off unless chosen, and warned against (docs/CONFIG.md). */
  secretsExportable?: boolean;
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
 * A recipe the server offers, as a starting point (docs/AUTOMATION-EDITOR.md):
 * a rule with roles to fill and settings, which the app copies — its
 * settings written into its blocks (`inlineParams`) — into an automation its
 * owner then edits. Recipes come with the installed packages; `from` says
 * which.
 */
export type RecipeView = {
  /** Namespaced by the type it came with: `acme.weather.forecast-switch`. */
  id: string;
  label: string;
  description: string;
  /** The package it came with; null for the shared vocabulary's own. */
  from: { typeId: string; name: string } | null;
  /** It waits for a condition to come true: only then can an automation of it keep things so (`recheckMinutes`). */
  hasConditions: boolean;
  /** It takes steps — waits, makes sure, chooses — rather than sending its commands at once. */
  takesSteps: boolean;
  /** Its steps in words, its roles named by their labels and its settings at their defaults. */
  steps: StepLine[];
  /** The rule itself, with its roles and its settings. */
  rule: Rule;
};

/**
 * A function an installed package offers a condition — "does tomorrow look
 * sunny?" — asked of a part that offers what it `needs`, with its arguments,
 * answering a value of `returns`. What an owner's condition may call.
 */
export type FunctionView = {
  /** Namespaced by the type it came with: `acme.weather.skyLooks`. */
  id: string;
  label: string;
  description: string;
  needs: { capabilities: readonly CapabilityName[]; oneOf?: readonly CapabilityName[] };
  args: Record<string, ValueType>;
  returns: ValueType;
};

/** `GET /automations/recipes`: what an automation can start from, and the functions its conditions may ask. */
export type AutomationKit = { recipes: RecipeView[]; functions: FunctionView[] };

/**
 * What fills an automation's roles: a part of a device for each role one
 * fills (`roles`), and another automation for each role a `start` step
 * starts (`starts`).
 */
export type RoleFills = { roles: Record<string, RoleBinding>; starts: Record<string, AutomationId> };

/** A rule as it is being built, with what fills its roles: `POST /automations/draft` checks and says it. */
export type AutomationDraft = RoleFills & { rule: Rule };

/** `POST /automations/draft`: what is wrong with a draft — empty, nothing — and how it reads. Nothing is kept. */
export type AutomationDraftView = {
  problems: string[];
  sentence: string;
  when: string[];
  steps: StepLine[];
  otherwise: StepLine[];
  takesSteps: boolean;
  /** Each role's name as its steps say it: "Scooter plug", "“Charge the scooter”". */
  names: Record<string, string>;
};

/** `POST /automations`. `timeZone` is the app's own clock: "Europe/Stockholm". `madeFrom`: the recipe it was copied from. */
/** `POST /automations`. `key`: its name in configuration; made from its name when not given. */
export type NewAutomation = AutomationDraft & { name: string; key?: string; madeFrom?: string | null; timeZone: string; recheckMinutes?: number | null };

/**
 * `PATCH /automations/:id`. A new rule comes with what fills its roles. Letting
 * it act, or changing one that acts, needs `confirmation`. `homePlace`: its
 * place among the shortcuts on the home page; null, off it.
 */
export type AutomationChanges = Partial<AutomationDraft> & {
  name?: string;
  /** Its name in configuration: lowercase letters, digits and dashes, no other automation's. */
  key?: string;
  timeZone?: string;
  mode?: AutomationMode;
  recheckMinutes?: number | null;
  homePlace?: number | null;
  confirmation?: string;
};

/** off: nothing; observe: decides and says what it would have done; armed: acts, through the gateway. */
export type AutomationMode = 'off' | 'observe' | 'armed';

export type AutomationRun = {
  /**
   * Which run it is; null when it is not kept: what it would do, asked, or a
   * run whose automation was deleted while it ran. Its outcome says which.
   */
  id: string | null;
  /** When it started. */
  at: string;
  /** The person or assistant who started it — or the run that started it; null when its own triggers did. */
  startedBy: string | null;
  /** The run of another automation whose step started it; null when none did, or it is gone. */
  startedByRun: { id: string; automationId: AutomationId; name: string } | null;
  /** When it ended; null while it runs. A run of commands alone ends as it starts. */
  endedAt: string | null;
  outcome:
    | 'acted' // what it did, the gateway carried out, verified
    | 'unverified' // the gateway sent it, but the effect is not proven
    | 'would-act' // observing: it would have acted
    | 'idle' // the condition was not met
    | 'unknown' // it could not tell
    | 'refused' // the gateway said no
    | 'failed' // a command errored, or a step did not succeed: waited in vain, never made sure
    | 'running' // it is taking its steps now
    | 'stopped' // someone stopped it
    | 'interrupted'; // the server restarted while it ran: it was ended, not resumed
  /** The run in one line, for a timeline or an assistant: "Turned Heater plug off". */
  summary: string;
  /**
   * What started it, in words: "Garage station's charge is at least 50 %",
   * "Every day at 07:00", "Looked again after 10 min: … still holds", "Asked
   * what it would do now", "Started by olof".
   */
  why: string;
  /** What it read to decide, as it was then: "Garage station: Charge 74.2 %". */
  saw: string[];
  /** Each condition it waits for, as it stood then. */
  conditions: ConditionState[];
  /**
   * Each step it took, or would have, in order, as it went — nested steps
   * after the step they belong to, one level deeper. Empty when it did
   * nothing.
   */
  steps: RunStep[];
};

/** One condition an automation waits for, and whether it holds: null when it cannot be judged (a device gone quiet). */
export type ConditionState = { text: string; holds: boolean | null };

/** A step of a run, as it went (docs/SEQUENCES.md). */
export type RunStep = {
  kind: StepKind;
  /** How deep it is: 0 for the rule's own steps, 1 for a step within one — a retry's, a choice's. */
  depth: number;
  /** What it is within, for a step with depth: "Try 2 of 3", "If it stays so", "After a step did not succeed". */
  within: string | null;
  /** "Turn Heater plug off", "Wait until Charger plug can be reached — at most 2 min". */
  what: string;
  /**
   * A command — done: carried out, and the device agrees; already: it
   * already was; unverified: sent, not proven; refused: the gateway said no;
   * failed: it errored; would: only watching, so nothing was sent.
   * A wait, a watch, making sure — waiting: now; met: it came true (a watch:
   * it stayed so); not-met: a watch that saw it not so; timed-out: it never
   * came true in time (making sure: in all its tries); done: a pause over, a
   * choice made. stopped: someone stopped the run here.
   */
  outcome: 'done' | 'already' | 'unverified' | 'refused' | 'failed' | 'would' | 'waiting' | 'met' | 'not-met' | 'timed-out' | 'stopped';
  /** In the gateway's words, or the engine's: "Confirmed by the device", "After 23 s", "Charger plug draws 238 W". */
  detail: string;
  at: string;
  endedAt: string | null;
  /** While it waits: until when, at the latest. */
  until: string | null;
};

export type AutomationView = RoleFills & {
  id: AutomationId;
  /** Its name in configuration: what a file and an import know it by (docs/CONFIG.md). */
  key: string;
  name: string;
  /** Its own rule, as its owner built it (docs/AUTOMATION-EDITOR.md). */
  rule: Rule;
  /** The recipe it was copied from, to say so; null when built from nothing. */
  madeFrom: { id: string; label: string } | null;
  /** What it does, in a sentence: "At 07:00, if tomorrow looks sunny by Weather, turn Heater plug on." */
  sentence: string;
  /** When it runs on its own, a sentence a trigger: "When Station's charge is below 15 % for 2 min". Empty: only when played or started. */
  when: string[];
  /** Each role's name as its steps say it: "Scooter plug", "“Charge the scooter”". */
  names: Record<string, string>;
  timeZone: string;
  /** Its place among the shortcuts on the home page; null when it is not there. */
  homePlace: number | null;
  mode: AutomationMode;
  /**
   * Keeping things so: every this many minutes, a condition that still holds
   * runs it again, unless what it would do is already so — or another
   * automation set it since: the last edge wins. Null: what it did stays
   * until a condition turns true again, and a person may change it.
   */
  recheckMinutes: number | null;
  /**
   * The other automations that change parts it changes, and which: "Also
   * changed by “Stop charging”: Scooter plug". While one runs, the other's run
   * that needs a part it holds is refused (docs/SHARED-PARTS-AND-RESERVE.md).
   */
  sharedWith: { id: AutomationId; name: string; parts: string[] }[];
  createdAt: string;
  updatedAt: string;
  /** Its latest run that has ended; null before its first. */
  lastRun: AutomationRun | null;
  /** Each condition it waits for, as it stands now, and what it reads to say so. */
  now: { conditions: ConditionState[]; saw: string[] };
  /** When it next looks again to keep things so; null when it does not, or is off. */
  nextLookAt: string | null;
  /** Why it cannot run as it is: a removed device. Empty when it can. */
  problems: string[];
  /** What it does, step by step, in words — and what it does if a step does not succeed. */
  steps: StepLine[];
  otherwise: StepLine[];
  /** It takes steps rather than sending its commands at once. */
  takesSteps: boolean;
  /** The run it is taking now, step by step as it goes; null when none runs. */
  running: AutomationRun | null;
};

/** `GET /automations/:id/runs`: its runs, the latest first — each with every step it took. */
export type AutomationRuns = { runs: AutomationRun[] };

/** A problem in a configuration file: what, the path to it, and its line and column when there is text (docs/CONFIG.md). */
export type ConfigProblem = { message: string; path: (string | number)[]; line: number | null; column: number | null };

/** What an import does to one device or automation: added, brought back (a device you removed, with its history), changed — and how — left as it is, or removed. */
export type ImportItem = { key: string; name: string; action: 'add' | 'restore' | 'change' | 'same' | 'remove'; changes: string[] };

/**
 * What importing a file would do, nothing yet done (`POST /config/plan`):
 * its problems, each with its line — none, and it can be applied — what
 * becomes of each device, link, automation and home value, and what it still
 * needs to be applied: a passphrase for its sealed secrets, a secret it does
 * not carry, a device of yours for a role naming one you do not have, and a
 * yes to what it would set acting on its own or remove.
 */
export type ImportPlan = {
  /** What `POST /config/apply` names it by, for 15 minutes; null when its problems stop it. */
  id: string | null;
  /** The version of the file, before it was brought to this one. */
  from: number | null;
  problems: ConfigProblem[];
  devices: ImportItem[];
  links: { kind: string; from: string; to: string; action: 'add' | 'same' | 'remove' }[];
  automations: ImportItem[];
  policy: { name: string; label: string; before: number | null; after: number }[];
  needs: {
    /** It carries secrets sealed with a passphrase, and none was given — or the one given does not open them. */
    passphrase: 'missing' | 'wrong' | null;
    /** A secret a way to reach a device needs, which the file does not carry and the device does not have: given as `secrets["device.field"]`. */
    secrets: { device: string; deviceName: string; field: string; title: string }[];
    /** A role naming a device you do not have: one of yours, as `rebind["automation.role"] = "device-key.part"`. */
    rebind: { automation: string; role: string; label: string; wanted: string; candidates: { use: string; name: string }[] }[];
    /** What applying it asks a yes to: an automation set acting on its own, devices and automations removed. */
    confirm: string[];
  };
  notes: string[];
};

/** What applying a plan did. */
export type ImportApplied = {
  /** `restored`: devices you had removed, brought back with their history. */
  devices: { added: string[]; restored: string[]; changed: string[]; removed: string[] };
  automations: { added: string[]; changed: string[]; removed: string[] };
  links: { added: number; removed: number };
  policy: string[];
  /** What was done otherwise than the file says — restoring, an automation kept turned off, a device left out — each in words. */
  notes: string[];
};

/** `POST /config/export`: everything, or the devices and automations chosen by key; secrets left out, sealed with a passphrase, or plain where allowed. */
export type ConfigExportRequest = { devices?: string[]; automations?: string[]; secrets: 'none' | 'sealed' | 'plain'; passphrase?: string };

/** An export: the file, and what could not go in (also in its heading). */
export type ConfigExported = { text: string; notes: string[] };

/** `POST /config/apply`: a plan, with the answers it asked for. */
export type ImportAnswers = {
  plan: string;
  /** Only these, by key; everything the plan has when not given. */
  include?: { devices?: string[]; automations?: string[] };
  /** A secret the file did not carry: "device.field" → its value. */
  secrets?: Record<string, string>;
  /** A role naming a device you do not have: "automation.role" → "device-key.part". */
  rebind?: Record<string, string>;
  confirmation?: string;
};

/** What the server's last restore from the configuration kept beside its database did. */
export type ConfigRestored = { at: string; from: string; applied: ImportApplied | null; problems: string[] };

/** `GET /config/snapshot`: the configuration kept beside the database — where, when it was last written, and what restoring it last did. */
export type ConfigSnapshotView = { path: string | null; writtenAt: string | null; restored: ConfigRestored | null };

/** A device a run used, as it was when the run ran. */
export type RunLogDevice = { id: string; name: string; typeId: string };

/** Which part of which device filled one of the run's roles as it ran. */
export type RunLogRole = { role: string; label: string; device: string; part: string };

/**
 * A value a run's log kept, as its device described it then: a number with
 * its unit and quantity, on/off with the words for each, one of some options,
 * or text (anything else, as JSON).
 */
export type RunLogKey = {
  device: string;
  key: string;
  part: string;
  label: string;
  kind: 'number' | 'boolean' | 'enum' | 'text';
  unit: string | null;
  quantity: Quantity | null;
  /** For on/off: how each is said; null when plainly on and off. */
  words: { true: string; false: string } | null;
  /** For one of some options: each option's label; null for any other kind. */
  options: EnumOption[] | null;
};

/** A reading a run's device gave: when the device took it, and when the run heard it. */
export type RunLogReading = { device: string; key: string; at: string; heardAt: string; value: Value };

/** Whether a run's device could be reached, from when — and why not, in its holder's words. */
export type RunLogReach = { device: string; at: string; reachable: boolean; detail: string };

/**
 * A run's log (`GET /automations/:id/runs/:runId/log`, docs/SEQUENCES.md):
 * the run, the devices and roles it used and every value they gave while it
 * ran, the earliest first — whole whatever became of the devices since.
 */
export type RunLog = {
  run: AutomationRun;
  devices: RunLogDevice[];
  roles: RunLogRole[];
  keys: RunLogKey[];
  readings: RunLogReading[];
  reach: RunLogReach[];
  /** It gave more readings than a run keeps: those after the last kept are not here. */
  capped: boolean;
};

// --- the one interface ------------------------------------------------------------

/**
 * Who is asking a home: what the gateway binds a person's yes to, what it
 * refuses an assistant, what setup drafts and import plans belong to, and
 * who the timeline names. The server makes one from a request's session;
 * an app with no server, one for its owner.
 */
export type Caller =
  /** A person, by the name the timeline knows them by. */
  | { kind: 'person'; name: string }
  /** An assistant acting for a person: it does what needs no one's yes, and is refused the rest. */
  | { kind: 'agent'; for: string };

/** A span of history asked for: `from` and `to`, or the last `hours` up to now, or the last day. */
export type HistoryQuery = { key: string; hours?: number; from?: string; to?: string; points?: number };
/** A span of changes asked for, of one key or all. */
export type ChangesQuery = { key?: string; hours?: number; from?: string; to?: string };

/**
 * Everything a home answers, whoever asks and wherever it is kept
 * (docs/PLAN-SHARED-CORE.md, principle 4): `@kraftverk/hub` answers it in
 * the process (`hub.as(caller)`), `@kraftverk/api-client` over HTTP, and
 * the server's routes are an adapter from one to the other. A refusal is an
 * `ApiError`; a command the gateway refuses is an answer, its verdict.
 * Accounts, sign-in and the reset are the server's, and not here.
 */
export interface KraftverkApi {
  /** What can be added: every installed type, with where each of its methods can be held here. */
  deviceTypes(): Promise<DeviceTypeList>;
  devices: {
    /** The devices you have, each with what it is doing. */
    list(): Promise<DeviceView[]>;
    /** Removed ones, kept with their history. */
    removed(): Promise<DeviceView[]>;
    /** One, removed or not. */
    get(id: SavedDeviceId): Promise<DeviceView>;
    /** Its name, and the key a configuration knows it by. */
    update(id: SavedDeviceId, changes: { name?: string; key?: string }): Promise<DeviceView>;
    /** Which picture it shows. */
    setPicture(id: SavedDeviceId, picture: PictureRef): Promise<DeviceView>;
    /** Removes it, keeping its history: adding it again brings it back. */
    remove(id: SavedDeviceId): Promise<void>;
    /** A removed device and everything it recorded, gone: its name, typed back, confirms it. */
    deleteHistory(id: SavedDeviceId, name: string): Promise<{ samples: number }>;
    /** One measurement over a span, thinned for a chart. */
    history(id: SavedDeviceId, query: HistoryQuery): Promise<DeviceHistory>;
    /** Every change of an on/off or an enum in a span. */
    changes(id: SavedDeviceId, query: ChangesQuery): Promise<DeviceChanges>;
    /** What it said happened, newest first. */
    events(id: SavedDeviceId, limit?: number): Promise<DeviceEventView[]>;
    /** A command to one of its parts, through the gateway: its verdict, refused or not. */
    command(id: SavedDeviceId, part: string, capability: string, command: string, body: CommandBody): Promise<GatewayResult>;
    /** Settings it keeps, through the gateway: its verdict, refused or not. */
    write(id: SavedDeviceId, write: AttributeWrite): Promise<WriteResult>;
    /**
     * One of its type's tools, with the answer it declares. `reading`: asked
     * as a read, so one that writes is refused; one that declares what it
     * cannot undo wants a person's yes, sent back as `confirmation`.
     */
    tool(id: SavedDeviceId, name: string, body: ToolBody & { reading?: boolean }): Promise<unknown>;
  };
  /** Warnings and errors across the devices you have, newest first. */
  problems(limit?: number): Promise<ProblemView[]>;
  connections: {
    /** This way first, whenever it can be reached. */
    prefer(device: SavedDeviceId, connection: ConnectionId): Promise<DeviceView>;
    /** One way to reach it removed: not the last. */
    remove(device: SavedDeviceId, connection: ConnectionId): Promise<DeviceView>;
    /** A connection's secrets replaced: write-only, as every secret is. */
    setSecrets(device: SavedDeviceId, connection: ConnectionId, secrets: Record<string, string>): Promise<DeviceView>;
    /** Whether its secrets may leave in an export as plain text. */
    setExportable(device: SavedDeviceId, connection: ConnectionId, exportable: boolean): Promise<DeviceView>;
  };
  links: {
    /** A fact about the house, between two parts. */
    add(link: NewLink): Promise<LinkRecord>;
    remove(id: LinkId): Promise<void>;
  };
}
