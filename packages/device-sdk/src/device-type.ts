import type { CapabilityImpl, CapabilityName } from './capabilities.ts';
import type { CategoryId } from './categories.ts';
import type { ConnectionMethod, Identified, OpenConnection, Platform } from './connection.ts';
import type { ConnectionHealth, SavedDeviceId } from './identity.ts';
import type { ConfigSchema, ConfigValues } from './schema.ts';
import type { SetupStep } from './setup.ts';
import type { MetricSpec, Reading } from './telemetry.ts';

/**
 * The contract a device type implements: what a contributor writes to add a
 * product to kraftverk, and all the core ever knows about it.
 *
 * A device type is a package (docs/ARCHITECTURE.md §3). It declares what its
 * devices measure, what they can do, what they remember, and the connection
 * methods it can be reached by; the holder of a device's connection opens a
 * session for it, over that connection. Nothing in the core names a product,
 * and nothing a device type runs knows whether it is running in the server or
 * in the app.
 */

export const DEVICE_API_VERSION = '3' as const;

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
  /** 'ATORCH S1W', 'Open-Meteo'. */
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

/**
 * Something a device can be told to do, as the app presents it.
 *
 * A control is a view of a capability command: which command, on which part of
 * the device, drawn how. It carries no authority of its own — whatever a
 * control asks goes through the gateway like any other command.
 */
export type ControlSpec = {
  id: string;
  label: string;
  kind: 'switch' | 'enum' | 'number' | 'button';
  capability: CapabilityName;
  /** The capability's command. `set` when absent. */
  command?: string;
  /** Which part of the device, for a capability with several: an outlet id. */
  target?: string;
  /** Physical and consequential: the app asks twice and says what happens. */
  dangerous?: boolean;
  /** The telemetry key showing what it currently reads. */
  measurementKey?: string;
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** One line explaining the consequence, shown before a dangerous action. */
  consequence?: string;
};

/**
 * What a device remembers itself: a charge limit, a standby timer.
 *
 * Distinct from config — choices kraftverk stores about the device — and from
 * controls, which are momentary. A setting survives a power cycle *on the device*.
 */
export type SettingsSpec = {
  schema: ConfigSchema;
  /**
   * Settings that can damage the hardware if set wrongly, so the app can treat
   * them with care without knowing which device it is looking at.
   */
  dangerous?: readonly string[];
};

/** What `identify` may use besides the connection. */
export type IdentifyContext = {
  /** The device's own config entered so far: a weather service's location. */
  config: ConfigValues;
  log: DeviceLogger;
  signal: AbortSignal;
};

export interface DeviceType<Config extends ConfigValues = ConfigValues> {
  /** Namespaced and stable forever: `atorch.s1w`, `open-meteo.weather`. Saved devices name it. */
  readonly id: string;
  readonly apiVersion: typeof DEVICE_API_VERSION;
  /** A service has no hardware: weather, prices. Shown in a section of its own. */
  readonly kind: 'hardware' | 'service';
  readonly meta: DeviceTypeMeta;
  /** What every device of this type offers. */
  readonly capabilities: readonly CapabilityName[];
  readonly telemetry: readonly MetricSpec[];
  readonly controls?: readonly ControlSpec[];
  readonly settings?: SettingsSpec;
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
 * Everything a caller reads comes from what the session already holds —
 * the session polls its own device — so reads are synchronous and cheap, and
 * a device that has stopped answering is reported by `health()` and by the
 * age of its readings, never by a read that hangs.
 */
export interface DeviceSession {
  health(): ConnectionHealth;
  /** The latest telemetry. Keys are the type's declared ones; null values are unknown. */
  readings(): Reading[];
  /** Null when this device does not offer it — or does not right now. */
  capability<N extends CapabilityName>(name: N): CapabilityImpl[N] | null;
  /** The device's settings as last read. Null until they have been read, never defaults. */
  readSettings?(): ConfigValues | null;
  /**
   * Applies settings, and returns what the device reports afterwards: a
   * readback, not an echo, because writing one setting can move another.
   */
  writeSettings?(patch: ConfigValues): Promise<ConfigValues | null>;
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

export type DeviceEvent = {
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
};

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
  /** Lands in the audit timeline. */
  emit(event: DeviceEvent): void;
}

/** Declares a device type, keeping its config type through to its session. */
export const defineDeviceType = <Config extends ConfigValues>(type: DeviceType<Config>): DeviceType<Config> => type;

/** A connection method as the app sees it. */
export type ConnectionMethodView = Omit<ConnectionMethod, 'steps'>;

/**
 * A device type as the app sees it: every declaration, and none of the code.
 *
 * What `GET /api/device-types` returns, and all the add flow needs to draw a
 * type it has never heard of. Each method's steps are asked for once a method
 * and a holder are chosen, because they depend on both.
 */
export type DeviceTypeView = {
  id: string;
  kind: 'hardware' | 'service';
  meta: DeviceTypeMeta;
  capabilities: readonly CapabilityName[];
  telemetry: readonly MetricSpec[];
  controls: readonly ControlSpec[];
  settings: SettingsSpec | null;
  config: ConfigSchema;
  connections: readonly ConnectionMethodView[];
  saveAnyway: string | null;
};

export const describeDeviceType = (type: DeviceType<any>): DeviceTypeView => ({
  id: type.id,
  kind: type.kind,
  meta: type.meta,
  capabilities: type.capabilities,
  telemetry: type.telemetry,
  controls: type.controls ?? [],
  settings: type.settings ?? null,
  config: type.config,
  connections: type.connections.map(({ steps: _steps, ...method }) => method),
  saveAnyway: type.setup?.saveAnyway ?? null,
});
