import type { CapabilityName, CommandResult } from './capabilities.ts';
import type { ConnectionMethod, Identified, OpenConnection } from './connection.ts';
import type { AttributeReading, DeviceDescription, DeviceInfo } from './description.ts';
import type { AdvancedAction, DeviceContext, DeviceStore, DeviceTypeMeta, IdentifyContext } from './device-type.ts';
import type { ConnectionHealth } from './identity.ts';
import type { ConfigSchema, ConfigValues } from './schema.ts';
import type { SetupStep } from './setup.ts';
import type { Value } from './values.ts';

/**
 * The device-type contract, version 4 (docs/ARCHITECTURE.md §8 step 24): a
 * device described by parts, attributes and events, commanded by typed
 * requests to a part's capability.
 *
 * It lives beside version 3 while the packages move (`upgradeDeviceType` in
 * `v3.ts` turns one into the other, so every holder can speak version 4 before
 * any package is rewritten). When the last package is native, in step 26, the
 * version-4 names become the only ones.
 */

export const DEVICE_MODEL_VERSION = '4' as const;

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
 * One device, open.
 *
 * Reads are synchronous and answer from what the session already holds — it
 * polls or listens to its own device — so a device that stopped answering is
 * reported by `health()` and the age of its readings, never by a read that
 * hangs.
 */
export interface DeviceSessionV4 {
  health(): ConnectionHealth;
  /** Every attribute's latest value, settings included. Null values are unknown. */
  readings(): AttributeReading[];
  /**
   * The device's own description, when it differs from what the type declared:
   * a pack plugged in, a standard's device that describes itself. Null when
   * the declared one holds. The holder calls `ctx.changed()`'s listeners again
   * when it changes.
   */
  description?(): DeviceDescription | null;
  /** What the device says about itself, as far as it has said. */
  info?(): DeviceInfo | null;
  /** Called by the gateway only. */
  command(request: CommandRequest): Promise<CommandResult>;
  query?(request: QueryRequest): Promise<unknown>;
  /**
   * Writes attributes the description marks `write`, and returns what the
   * device reports afterwards: a readback, not an echo, because writing one
   * can move another. Called by the gateway only.
   */
  write?(patch: Readonly<Record<string, Value>>): Promise<Readonly<Record<string, Value>> | null>;
  /** The device's own permanent id and the name it reports, once it has said. */
  identity?(): { id: string | null; name: string | null };
  readonly advanced?: Readonly<Record<string, AdvancedAction>>;
  close(): Promise<void>;
}

/** What a version-4 session is given: a version-3 context, and two ways to speak up. */
export interface DeviceContextV4<Config extends ConfigValues = ConfigValues> extends DeviceContext<Config> {
  /** Something changed — a reading, the description, the information — for devices that push. */
  changed(): void;
  /** Raises an event the description declares. Its data is checked against the declaration. */
  event(id: string, data?: Readonly<Record<string, Value>>, part?: string): void;
}

/** What `identify` finds, and — when the device says — its information and description. */
export type IdentifiedV4 = Identified & { info?: DeviceInfo; description?: DeviceDescription };

export interface DeviceTypeV4<Config extends ConfigValues = ConfigValues> {
  /** Namespaced and stable forever: `acme.plug`. Saved devices name it. */
  readonly id: string;
  readonly apiVersion: typeof DEVICE_MODEL_VERSION;
  /**
   * This type's own version, a whole number from 1. Raised when what it
   * stores — config, its store, attribute keys — changes shape, with `migrate`
   * saying how to move a device saved under an older one.
   */
  readonly version: number;
  readonly kind: 'hardware' | 'service';
  readonly meta: DeviceTypeMeta;
  /** Choices kraftverk keeps about each device: a profile, a location. Never secrets. */
  readonly config: ConfigSchema;
  readonly connections: readonly ConnectionMethod[];
  readonly setup?: { steps?: readonly SetupStep<Config>[]; saveAnyway?: string };

  /** What a device of this type is, given its config. */
  describe(config: Config): DeviceDescription;
  identify(connection: OpenConnection, ctx: IdentifyContext): Promise<IdentifiedV4>;
  createSession(ctx: DeviceContextV4<Config>): Promise<DeviceSessionV4>;
  /** The same contract with no hardware: tests, the contract suite, trying the app. */
  createSimulator(ctx: DeviceContextV4<Config>): Promise<DeviceSessionV4>;
  /**
   * Moves a device saved under version `from` to this one, before its session
   * opens: returns its config as it now should be, and may rewrite its store.
   */
  migrate?(from: number, state: { config: ConfigValues; store: DeviceStore }): ConfigValues | Promise<ConfigValues>;
}

export const defineDeviceTypeV4 = <Config extends ConfigValues>(type: DeviceTypeV4<Config>): DeviceTypeV4<Config> => type;
