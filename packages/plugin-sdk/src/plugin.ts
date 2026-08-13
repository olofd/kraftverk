import type { CapabilityImpl, CapabilityName } from './capabilities.ts';
import type { DeviceProvider } from './device.ts';
import type { ConfigSchema, ConfigValues, ValidationResult } from './schema.ts';

/**
 * The plugin contract.
 *
 * A plugin imports this package and nothing else: no station driver, no
 * database handle, no `fetch`, no core configuration. Everything it is allowed
 * to touch arrives through `PluginContext`, which is what makes a failing or
 * hostile plugin a contained problem rather than a station-wide one.
 */

export type PluginKind = 'grid-relay' | 'weather' | 'pv-forecast' | 'price' | 'home-automation';

export type PluginManifest = {
  /** Reverse-DNS and stable forever: this is the identity config is filed under. */
  id: string;
  name: string;
  description: string;
  /** Semver of the plugin itself. */
  version: string;
  /** The SDK contract it was written against. */
  apiVersion: '1';
  kind: PluginKind;
  capabilities: readonly CapabilityName[];
  configSchema: ConfigSchema;
  /** Commissioning helpers the app renders generically. See `SetupAction`. */
  setupActions?: readonly SetupAction[];
  ui: {
    /** Feather icon name, so the app needs nothing from the plugin to draw it. */
    icon: string;
    setupHelp?: string;
  };
  /** Hosts `context.http` may reach. Empty means the plugin makes no HTTP calls. */
  allowedHosts?: readonly string[];
};

export type PluginStatus =
  | 'installed'
  | 'needs-configuration'
  | 'starting'
  | 'healthy'
  | 'degraded'
  | 'failed'
  | 'disabled';

export type PluginHealth = {
  status: Exclude<PluginStatus, 'installed' | 'disabled'>;
  /** One sentence a human can act on. Used for problems. */
  detail?: string;
  /** When this plugin last got a real answer from whatever it talks to. */
  lastOk?: string;
  /** Age of the freshest data it holds. Stale never renders as healthy. */
  dataAgeMs?: number;
  /**
   * A few label/value pairs describing what this plugin currently knows.
   *
   * The card in the app renders these verbatim, which is how one screen shows
   * "Relay: on · Power: 240 W" for a plug and "Now: 4 °C, cloudy · Tomorrow:
   * 1.9 kWh" for a weather source without learning anything about either.
   * Formatting — units, rounding, wording — belongs to the plugin, because
   * only the plugin knows what its numbers mean.
   */
  facts?: readonly { label: string; value: string }[];
};

export type PluginLogger = {
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
};

/** Namespaced key/value storage. A plugin cannot see another's rows. */
export type PluginStore = {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
};

export type PluginEvent = {
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
};

export type PluginContext = {
  log: PluginLogger;
  /** Validated, defaults applied, secrets excluded. */
  config: ConfigValues;
  /** This plugin's own secrets, by field name. Never enumerable. */
  secrets: { get(field: string): string | null };
  store: PluginStore;
  /**
   * Repeating work, cancelled automatically on `stop()`.
   *
   * Overlapping runs are skipped rather than queued: a plug that stops
   * answering must not accumulate a backlog of polls that all fire at once when
   * it comes back.
   */
  schedule(everyMs: number, task: () => void | Promise<void>): void;
  /** `fetch` with a mandatory timeout, restricted to the manifest's hosts. */
  http(url: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
  /** Lands in the audit timeline. */
  emit(event: PluginEvent): void;
  /** Refused unless the capability is declared in the manifest. */
  registerCapability<N extends CapabilityName>(name: N, implementation: CapabilityImpl[N]): void;
};

/**
 * A one-off helper the app can run while you are setting a plugin up.
 *
 * Commissioning almost always needs something the config form cannot do: scan
 * the network, fetch a credential, list the entities on a hub. Rather than let
 * each plugin ship UI for that, a plugin *declares* its helpers and the app
 * renders them from the same schema language as the config form — so the
 * client learns nothing plugin-specific, and a plugin added later gets a setup
 * flow for free.
 *
 * The result may propose configuration values, which the app offers to apply.
 */
export type SetupAction = {
  id: string;
  title: string;
  description?: string;
  /** Empty when the action needs no input, e.g. "scan the network". */
  input?: ConfigSchema;
  /** Label for the button. */
  actionLabel?: string;
};

/**
 * One of several things the user might pick.
 *
 * Setup helpers nearly always end the same way — *here are three devices, which
 * is yours?* — so that shape belongs in the contract. The app renders a list
 * and writes the chosen `config` into the form; it needs to know nothing about
 * what is being chosen, which is what makes the same screen work for a Tuya
 * plug, a Home Assistant entity, or a weather station.
 */
export type SetupChoice = {
  id: string;
  label: string;
  /** A second line: an address, a product name, a distance. */
  detail?: string;
  /** Applied to the configuration form when this one is chosen. */
  config: ConfigValues;
  /** Marks the option the plugin thinks is right. */
  recommended?: boolean;
};

export type SetupActionResult = {
  ok: boolean;
  /** One sentence for the user. */
  detail: string;
  /** Anything else worth showing: a datapoint dump, raw diagnostics. */
  data?: Record<string, unknown>;
  /** Several candidates to choose between. */
  choices?: readonly SetupChoice[];
  /**
   * A single unambiguous answer, applied without a choice.
   *
   * Secrets are permitted here — this is a direct response to something the
   * user just asked for, not something stored or logged.
   */
  suggestedConfig?: ConfigValues;
};

export interface KraftverkPlugin extends Partial<DeviceProvider> {
  readonly manifest: PluginManifest;
  /** Called before `start`, and on every config change. */
  validateConfig(config: unknown): ValidationResult;
  start(context: PluginContext): Promise<void>;
  stop(): Promise<void>;
  health(): PluginHealth;
  /**
   * A side-effect-free probe, for the "Test" button.
   *
   * For a relay this must never switch anything — it connects, reads, and
   * reports what it found. The Tuya plugin uses it to dump every datapoint,
   * which is how a new plug's map gets established.
   */
  test?(): Promise<{ ok: boolean; detail: string; data?: Record<string, unknown> }>;

  /**
   * Runs a helper declared in `manifest.setupActions`.
   *
   * Must work on a stopped, unconfigured plugin — the whole point is to get you
   * to a working configuration — so it takes everything it needs as input
   * rather than reading `context`.
   */
  runSetupAction?(id: string, input: ConfigValues): Promise<SetupActionResult>;
}

/** What a plugin package exports, and what the host looks for. */
export type PluginFactory = () => KraftverkPlugin;

export const SDK_API_VERSION = '1' as const;

/** Whether the host can run a plugin built against `apiVersion`. */
export const isCompatible = (apiVersion: string): boolean => apiVersion === SDK_API_VERSION;
