import type { CapabilityName, CommandResult } from './capabilities.ts';
import type { CategoryId } from './categories.ts';
import { methodsOf, type ConnectionMethod, type Identified, type OpenConnection, type Platform } from './connection.ts';
import { deviceCapabilities, type DeviceDescription, type DeviceInfo, type Reading } from './description.ts';
import type { ConnectionHealth, SavedDeviceId } from './identity.ts';
import { configDefaults, type ConfigSchema, type ConfigValues } from './schema.ts';
import type { SetupStep } from './setup.ts';
import type { Value } from './values.ts';

/**
 * The contract a device type implements: what a contributor writes to add a
 * product to kraftverk, and all the core ever knows about it.
 *
 * A device type is a package (docs/ARCHITECTURE.md §3). It describes its
 * devices — parts, attributes, events (`description.ts`) — and the connection
 * methods it can be reached by; the holder of a device's connection opens a
 * session for it, over that connection. A session reports attributes and
 * takes commands and queries addressed to a part and a capability. Nothing in
 * the core names a product, and nothing a device type runs knows whether it is
 * running in the server or in the app.
 */

/**
 * How far a device type is trusted.
 *
 * - `verified` — confirmed on real hardware, by someone who owns one.
 * - `community` — works for its author; not checked here.
 * - `experimental` — believed to work, from documentation or a related model.
 *   Shown as such, so odd numbers are expected rather than alarming.
 */
export type SupportLevel = 'verified' | 'community' | 'experimental';

export type DeviceTypeMeta = {
  /** 'Acme plug', 'Acme weather'. */
  name: string;
  brand?: string;
  /**
   * The model names it covers, as the devices report them. Search uses them,
   * and so does the check step: a device reporting a model another installed
   * type claims is offered as that type instead.
   */
  models?: readonly string[];
  /** Where the add screen lists it. Never behaviour — that comes from capabilities. */
  category: CategoryId;
  /** One or two sentences for the add screen. */
  description?: string;
  support: SupportLevel;
  /** Why that support level, in one sentence. */
  supportNote?: string;
  /** A Feather icon name, so the app can draw it with nothing from the package. */
  icon: string;
  /** A product picture, as a path inside the package. Served by the server. */
  image?: string;
  docsUrl?: string;
};

/** What `identify` may use besides the connection. */
export type IdentifyContext = {
  /** The device's own config entered so far: a weather service's location. */
  config: ConfigValues;
  log: DeviceLogger;
  signal: AbortSignal;
};

export interface DeviceType<Config extends ConfigValues = ConfigValues> {
  /** Namespaced and stable forever: `acme.plug`, `acme.weather`. Saved devices name it. */
  readonly id: string;
  /** A service has no hardware: weather, prices. Shown in a section of its own. */
  readonly kind: 'hardware' | 'service';
  readonly meta: DeviceTypeMeta;
  /** Choices kraftverk keeps about each device: a profile, a location. Never secrets. */
  readonly config: ConfigSchema;
  /** How a device of this type can be reached. At least one. */
  readonly connections: readonly ConnectionMethod[];
  /**
   * Steps of the type's own, whatever the method: asking for a location, a
   * profile. `saveAnyway`, when present, is why saving after a failed check is
   * reasonable for this type — a station that is asleep — and offers it.
   */
  readonly setup?: { steps?: readonly SetupStep<Config>[]; saveAnyway?: string };

  /**
   * What a device of this type is, given its config: its parts, attributes and
   * events. A session may report a description of its own instead, when the
   * device decides (a pack plugged in); this is what holds until it does.
   */
  describe(config: Config): DeviceDescription;
  /**
   * Reads the device once over an open connection: what it is, what it calls
   * itself, and a sentence to show. Switches nothing. What the check step runs.
   */
  identify(connection: OpenConnection, ctx: IdentifyContext): Promise<Identified>;
  /** Opens one saved device, over its connection. */
  createSession(ctx: DeviceContext<Config>): Promise<DeviceSession>;
  /**
   * A device that is not there, keeping the same contract: for tests, the
   * contract suite, and trying the app without hardware. Its context has no
   * connection.
   */
  createSimulator(ctx: DeviceContext<Config>): Promise<DeviceSession>;
}

/** A command to one part of a device: `switch.set({ on: true })` on `outlet.ac`. */
export type CommandRequest = {
  part: string;
  capability: CapabilityName;
  command: string;
  args: Readonly<Record<string, Value>>;
};

/** A question to one part, answered with data that is not a value now: a forecast. */
export type QueryRequest = {
  part: string;
  capability: CapabilityName;
  query: string;
  args: Readonly<Record<string, Value>>;
};

/**
 * A tool of this kind of device beyond its capabilities and settings: a
 * register dump, a raw frame. The core serves each one under
 * `/devices/:id/advanced/:name`, refuses one that `writes` while read-only, and
 * audits every call that writes.
 */
export type AdvancedAction = {
  /** Changes something on the device. */
  writes: boolean;
  /**
   * It checks read-only mode itself, call by call, so the core does not refuse
   * it outright while read-only: a raw frame that is plainly a read changes
   * nothing, and reading undocumented registers is how a unit is brought up.
   * Only for a tool that may write; it must refuse every write while read-only.
   */
  honoursReadOnly?: boolean;
  run(input: Readonly<Record<string, unknown>>): Promise<unknown>;
};

/**
 * One device, open.
 *
 * Everything a caller reads comes from what the session already holds — the
 * session polls or listens to its own device — so reads are synchronous and
 * cheap, and a device that has stopped answering is reported by `health()` and
 * by the age of its readings, never by a read that hangs.
 */
export interface DeviceSession {
  health(): ConnectionHealth;
  /** Every attribute's latest value, settings included. Null values are unknown. */
  readings(): Reading[];
  /**
   * The device's own description, when it differs from the type's: a pack
   * plugged in, a standard's device that describes itself. Null while the
   * type's holds. Call `ctx.changed()` when it changes.
   */
  description?(): DeviceDescription | null;
  /** What the device says about itself, as far as it has said. */
  info?(): DeviceInfo | null;
  /** A command to a part's capability. Called by the gateway only. */
  command(request: CommandRequest): Promise<CommandResult>;
  query?(request: QueryRequest): Promise<unknown>;
  /**
   * Writes attributes the description marks `write`, and returns what the
   * device reports afterwards: a readback, not an echo, because writing one
   * can move another. Called by the gateway only.
   */
  write?(patch: Readonly<Record<string, Value>>): Promise<Readonly<Record<string, Value>>>;
  /**
   * What the device says about itself: its own permanent id, namespaced by
   * protocol, and the name it reports. Null parts until it has said. Never
   * the user's name for it, which the core keeps.
   */
  identity?(): { id: string | null; name: string | null };
  /** Tools of this kind of device: see `AdvancedAction`. */
  readonly advanced?: Readonly<Record<string, AdvancedAction>>;
  close(): Promise<void>;
}

// --- what a session is given -------------------------------------------------

export type DeviceLogger = {
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
};

/** Storage of the device's own. No device can see another's. */
export type DeviceStore = {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
};

/** `fetch` with a mandatory timeout. */
export type ScopedHttp = (url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<Response>;

export interface DeviceContext<Config extends ConfigValues = ConfigValues> {
  readonly deviceId: SavedDeviceId;
  /** This device's own config: validated, defaults applied. */
  readonly config: Config;
  /** The connection in use, already open. Null for a simulator. */
  readonly connection: OpenConnection | null;
  readonly store: DeviceStore;
  readonly log: DeviceLogger;
  /** Every hardware write is refused. A session must honour it too. */
  readonly readOnly: boolean;
  /**
   * The holder was started with raw access to hardware, for bringing up an
   * unfamiliar unit: frames nobody has described may be sent. The protocol's
   * guard still applies.
   */
  readonly allowRawFrames: boolean;
  /** Where this session is running. */
  readonly platform: Platform;
  /**
   * Repeating work, cancelled when the session closes. A run still going when
   * the next is due is skipped, not queued: a device that stops answering must
   * not build a backlog that fires all at once when it returns.
   */
  schedule(everyMs: number, task: () => void | Promise<void>): void;
  /** Something changed — a reading, the description, the information — for devices that push. */
  changed(): void;
  /**
   * Raises an event the description declares: an overload, a button. Checked
   * against the declaration; it lands on the timeline and can start an
   * automation.
   */
  event(id: string, data?: Readonly<Record<string, Value>>, part?: string): void;
}

/** Declares a device type, keeping its config type through to its session. */
export const defineDeviceType = <Config extends ConfigValues>(type: DeviceType<Config>): DeviceType<Config> => type;

/** A connection method as the app sees it. */
export type ConnectionMethodView = Omit<ConnectionMethod, 'steps'>;

/**
 * A device type as the app sees it: every declaration, and none of the code.
 *
 * What `GET /api/device-types` returns, and all the add flow needs to draw a
 * type it has never heard of. Its description is the one a device with the
 * default config has. Each method's steps are asked for once a method and a
 * holder are chosen, because they depend on both.
 */
export type DeviceTypeView = {
  id: string;
  kind: 'hardware' | 'service';
  meta: DeviceTypeMeta;
  description: DeviceDescription;
  capabilities: readonly CapabilityName[];
  config: ConfigSchema;
  connections: readonly ConnectionMethodView[];
  saveAnyway: string | null;
};

export const describeDeviceType = (type: DeviceType<any>): DeviceTypeView => {
  const description = type.describe(configDefaults(type.config));
  return {
    id: type.id,
    kind: type.kind,
    meta: type.meta,
    description,
    capabilities: deviceCapabilities(description),
    config: type.config,
    // Simulated included: every type can be tried with no hardware.
    connections: methodsOf(type).map(({ steps: _steps, ...method }) => method),
    saveAnyway: type.setup?.saveAnyway ?? null,
  };
};
