import type { CapabilityName } from './capabilities.ts';

/**
 * A thing you own.
 *
 * The distinction this file exists to draw: a plugin is a *driver*, and the
 * things it provides are *devices*. One Tuya driver provides one plug; a Home
 * Assistant driver would provide dozens; and the power station is a device with
 * no driver at all, because it is built in. Making the station just another
 * device is what stops it being a special case forever.
 *
 * Everything the app shows about a device — its card, its readings, its charts,
 * its buttons, and the automations you can build from it — comes from these
 * declarations. Nobody writes a screen for a particular device.
 */

export type DeviceKind =
  | 'power-station'
  | 'smart-plug'
  | 'meter'
  | 'sensor'
  /**
   * Reserved, and deliberately unused.
   *
   * Weather and price feeds are *plugins*, not devices: you do not own them,
   * and they do not belong on a canvas called "your devices". Where their
   * configuration lives is an open question until the first one is written —
   * see PROJECT-BRIEF.md. Nothing should return this kind today.
   */
  | 'service';

/**
 * Something a device measures.
 *
 * `kind` is what lets one chart component render any series: it decides
 * formatting, axis behaviour and whether zero means "nothing happening" or
 * "genuinely zero". Adding a kind is a decision about every device at once,
 * which is the friction that keeps the list short.
 */
export type MeasurementSpec = {
  key: string;
  label: string;
  unit: string;
  kind:
    | 'power'
    | 'energy'
    | 'percent'
    | 'voltage'
    | 'current'
    | 'temperature'
    | 'frequency'
    | 'duration'
    /** On/off, open/closed. Charted as a band, not a line. */
    | 'state';
  precision?: number;
  /** A counter that only rises. Charted as change per interval. */
  cumulative?: boolean;
  /** The one shown on the device's card. Exactly one per device. */
  primary?: boolean;
};

export type Reading = {
  key: string;
  value: number | boolean | null;
  /** When the device actually produced it — not when we asked. */
  at: string;
};

/**
 * Something a device can be told to do.
 *
 * Declaring controls is what answers "what can this plug do?" without the app
 * knowing what a plug is, and the same list drives both the buttons on the
 * device screen and the actions offered when wiring devices together.
 */
export type ControlSpec = {
  id: string;
  label: string;
  kind: 'switch' | 'enum' | 'number' | 'button';
  /** The permission required. Actuators need a grant and a confirmation. */
  capability: CapabilityName;
  /** Physical and consequential: the app asks twice and says what happens. */
  dangerous?: boolean;
  /** What the control currently reads, when it maps to a measurement. */
  measurementKey?: string;
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** One line explaining the consequence, shown before a dangerous action. */
  consequence?: string;
};

export type DeviceDescriptor = {
  /** Stable and namespaced: `tuya:bf8dc9…`, `station:AC276E629BEA`. */
  id: string;
  /** The vendor's name for it. The user's own name is stored by the core. */
  name: string;
  kind: DeviceKind;
  icon: string;
  /** Model, product name — whatever helps tell two of them apart. */
  description?: string;

  /** What it measures. Sampled into history; charted generically. */
  measurements: readonly MeasurementSpec[];
  /** What it can be told to do, right now. */
  controls: readonly ControlSpec[];
  /**
   * Persistent configuration that lives *on the device*.
   *
   * The third leg, and the one that is easy to conflate with the other two. A
   * control is momentary — flip this port. A setting is remembered by the
   * hardware and survives a power cycle: a charge limit, a standby timer. The
   * station's whole settings screen is this, and describing it as a schema
   * means the generic form can render any device's settings, while a device
   * with strong opinions can still draw its own.
   *
   * Distinct from a *plugin's* config, which is how the driver reaches the
   * thing (addresses, keys) and never leaves the server.
   */
  settings?: DeviceSettingsSpec;

  /** What this device can do, for wiring and for permission checks. */
  capabilities?: readonly CapabilityName[];
};

/** A device's own settings: what they are, and how dangerous each one is. */
export type DeviceSettingsSpec = {
  schema: import('./schema.ts').ConfigSchema;
  /**
   * Settings that can damage the hardware if set wrongly.
   *
   * The P280 has a register that permanently bricks the station when written
   * zero; the app must be able to know that a field is in that class without
   * hard-coding which device it belongs to.
   */
  dangerous?: readonly string[];
};

/** What a plugin — or the core — implements to provide devices. */
export interface DeviceProvider {
  /** The devices this plugin currently provides. May change with config. */
  devices(): DeviceDescriptor[];
  /** Current readings for one device. Stale is reported, never hidden. */
  readDevice(deviceId: string): Promise<Reading[]>;
  /**
   * Invokes a control.
   *
   * Never called directly by anything but the core's action gateway, which has
   * already checked the grant, the policy and the freshness of the data.
   */
  invokeControl?(deviceId: string, controlId: string, value: unknown): Promise<void>;

  /** Current values of the device's own settings. */
  readSettings?(deviceId: string): Promise<import('./schema.ts').ConfigValues>;
  /**
   * Applies settings, and returns what the device reports afterwards.
   *
   * The return value is a readback, not an echo: writing one setting can move
   * another on this hardware, so callers must be told what actually happened
   * rather than what they asked for.
   */
  writeSettings?(
    deviceId: string,
    patch: import('./schema.ts').ConfigValues
  ): Promise<import('./schema.ts').ConfigValues>;
}

/** The reading for one key, or null when the device has not reported it. */
export const readingOf = (readings: readonly Reading[], key: string): Reading | null =>
  readings.find((reading) => reading.key === key) ?? null;

/** The measurement a card should lead with. */
export const primaryOf = (device: DeviceDescriptor): MeasurementSpec | null =>
  device.measurements.find((measurement) => measurement.primary) ?? device.measurements[0] ?? null;
