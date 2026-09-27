import type { CapabilityImpl, CapabilityName } from './capabilities.ts';
import type { ConnectionHealth, SavedDeviceId } from './identity.ts';
import type { ConfigSchema, ConfigValues } from './schema.ts';
import type { SetupGuide } from './setup.ts';
import type { MetricSpec, Reading } from './telemetry.ts';

/**
 * The contract a device type implements: what a contributor writes to add a
 * product to kraftverk, and all the core ever knows about it.
 *
 * A device type is a package (docs/ARCHITECTURE.md §3). It declares what its
 * devices measure, what they can do, what they remember and how to set one up;
 * the server opens a session for every saved device of the type, with that
 * device's own config; the app draws it from the declarations, or from panels
 * the package ships. Nothing in the core names a product.
 */

export const DEVICE_API_VERSION = '2' as const;

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
  /** 'ATORCH S1W', 'Weather (Open-Meteo)'. */
  name: string;
  brand?: string;
  /** Model names it covers, for the add screen's search. */
  models?: readonly string[];
  /**
   * Free text, for grouping on screen: 'battery', 'smart-plug',
   * 'weather'. Never behaviour — that comes from capabilities.
   */
  category: string;
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
 * Distinct from config — how the server reaches the device — and from controls,
 * which are momentary. A setting survives a power cycle *on the device*.
 */
export type SettingsSpec = {
  schema: ConfigSchema;
  /**
   * Settings that can damage the hardware if set wrongly, so the app can treat
   * them with care without knowing which device it is looking at.
   */
  dangerous?: readonly string[];
};

export interface DeviceType<Config extends ConfigValues = ConfigValues> {
  /** Namespaced and stable forever: `atorch.s1w`, `open-meteo.forecast`. Saved devices name it. */
  readonly id: string;
  readonly apiVersion: typeof DEVICE_API_VERSION;
  /** A service has no hardware: weather, prices. Shown in a section of its own. */
  readonly kind: 'hardware' | 'service';
  readonly meta: DeviceTypeMeta;
  /** The protocols it speaks, by name: for display and dependency checks. */
  readonly protocols: readonly string[];
  /** What every device of this type offers. */
  readonly capabilities: readonly CapabilityName[];
  readonly telemetry: readonly MetricSpec[];
  readonly controls?: readonly ControlSpec[];
  readonly settings?: SettingsSpec;
  /** How the server reaches one device: addresses, keys. Secrets are marked as such. */
  readonly config: ConfigSchema;
  readonly setup: SetupGuide<Config>;

  /** Opens one saved device. Called by the server only. */
  createSession(ctx: DeviceContext<Config>): Promise<DeviceSession>;
  /**
   * A device that is not there, keeping the same contract: for tests, the
   * contract suite, and trying the app without hardware.
   */
  createSimulator(ctx: DeviceContext<Config>): Promise<DeviceSession>;
}

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

/**
 * The shared things the server owns and a session borrows: the Bluetooth
 * radio, the MQTT broker, a UDP socket for discovery.
 *
 * A device type never opens a radio itself — the server has one, and every
 * device on it shares it. Each resource is named and typed by the protocol
 * package that needs it, which is why this is a lookup by name rather than a
 * fixed list here.
 */
export type TransportRuntime = {
  get<T = unknown>(name: string): T | null;
};

export type DeviceEvent = {
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
};

export interface DeviceContext<Config extends ConfigValues = ConfigValues> {
  readonly deviceId: SavedDeviceId;
  /** This device's own config: validated, defaults applied, secrets excluded. */
  readonly config: Config;
  /** This device's own secrets, by config field. */
  readonly secrets: { get(field: string): string | null };
  readonly store: DeviceStore;
  readonly log: DeviceLogger;
  readonly http: ScopedHttp;
  readonly transports: TransportRuntime;
  /** True when the server refuses every hardware write. A session must honour it too. */
  readonly readOnly: boolean;
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
