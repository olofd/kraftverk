import type { StandardMetricId } from './telemetry.ts';

/**
 * Capabilities: what a device can do or report, named by what it is rather than
 * by what one installation uses it for.
 *
 * A plug offers `switch` — not "grid relay": that it feeds a station's AC input
 * is a fact about the house, recorded as a link between the two devices
 * (docs/ARCHITECTURE.md §4.4), and the same plug could as well switch a heater.
 * Automations and the gateway ask for "a device that can switch", and never for
 * a product.
 *
 * The library is small on purpose and grows one reviewed addition at a time:
 * every capability is a promise every device type offering it must keep, and
 * every consumer may rely on.
 *
 * Reads are synchronous and answer from what the session already holds: a
 * device is polled by its own session, not by whoever happens to ask. Every
 * read says *when* the device produced it, and null means the device has not
 * said — unknown, which is never the same as off or zero.
 */

/** A value, and when the device produced it. */
export type Stamped<T> = T & {
  /** When the device itself last reported this — not when anyone asked. */
  at: string;
};

/**
 * What a command came to.
 *
 * Accepted is not proof: the device took the command. Whether anything
 * physical happened is for the gateway to establish, from the capability's own
 * readback and whatever the device's links add.
 */
export type CommandResult = { accepted: true } | { accepted: false; error: string };

// --- switch -----------------------------------------------------------------

/**
 * What a relay does when power returns after a cut.
 *
 * A plug that feeds a station's charger and comes back `off` can strand a flat
 * battery with no way to charge, so this is recorded from a real power-cut test
 * and `unknown` is a value, not an omission.
 */
export type BootBehaviour = 'on' | 'off' | 'last' | 'unknown';

export interface SwitchCapability {
  /** Null until the device has said. */
  state(): Stamped<{ on: boolean }> | null;
  /** Called by the gateway only. */
  set(on: boolean): Promise<CommandResult>;
  bootBehaviour(): BootBehaviour;
}

// --- power metering ---------------------------------------------------------

export type PowerMeterReading = {
  watts: number | null;
  volts?: number | null;
  amps?: number | null;
  /** The device's own lifetime counter. */
  kwh?: number | null;
  hz?: number | null;
  powerFactor?: number | null;
};

export interface PowerMeterCapability {
  read(): Stamped<PowerMeterReading> | null;
}

// --- battery ----------------------------------------------------------------

export interface BatteryCapability {
  read(): Stamped<{ socPercent: number | null; capacityWh: number | null }> | null;
}

// --- outlets ----------------------------------------------------------------

export type OutletState = {
  /** The device's own name for it, stable: `ac`, `usb`. */
  id: string;
  label: string;
  on: boolean | null;
  watts: number | null;
};

/** Several switched outputs on one device, as a power station has. */
export interface OutletsCapability {
  read(): Stamped<{ outlets: OutletState[] }> | null;
  /** Called by the gateway only. */
  set(outletId: string, on: boolean): Promise<CommandResult>;
}

// --- AC input ---------------------------------------------------------------

/** Whether mains is reaching this device, and how much it takes from it. */
export interface AcInputCapability {
  read(): Stamped<{ present: boolean | null; watts: number | null }> | null;
}

// --- weather ----------------------------------------------------------------

export type WeatherHour = {
  /** The start of the hour. */
  at: string;
  temperatureC: number | null;
  cloudCoverPercent: number | null;
  precipitationMm: number | null;
  /** Global horizontal irradiance: what reaches a panel lying flat. */
  irradianceWm2: number | null;
};

export interface WeatherForecastCapability {
  /** From what the session holds; empty until the first forecast arrives. */
  hourly(hours: number): WeatherHour[];
}

// --- the library -------------------------------------------------------------

/**
 * How careful the gateway must be with a command.
 *
 * - `safe` — carried out when asked.
 * - `confirm` — the caller must confirm, every time.
 * - `confirm-off-when-critical` — turning something off needs confirmation when
 *   it matters: the device feeds another through a link, or the outlet is
 *   carrying a load. Turning it on, or off when nothing depends on it, does not.
 *
 * The gateway also applies read-only mode, dwell time and freshness to every
 * command, whatever its level (docs/ARCHITECTURE.md §4.6).
 */
export type CommandSafety = 'safe' | 'confirm' | 'confirm-off-when-critical';

export type CapabilitySpec = {
  label: string;
  /** The commands it accepts. None means it only reports. */
  commands: Readonly<Record<string, { safety: CommandSafety; description: string }>>;
  /** Telemetry a device offering it must report, so it can be charted and automated. */
  requires: readonly StandardMetricId[];
};

export const CAPABILITIES = {
  switch: {
    label: 'Switch',
    commands: { set: { safety: 'confirm-off-when-critical', description: 'Turn it on or off' } },
    requires: ['switch.on'],
  },
  powerMeter: {
    label: 'Power meter',
    commands: {},
    requires: ['power.draw'],
  },
  battery: {
    label: 'Battery',
    commands: {},
    requires: ['battery.soc'],
  },
  outlets: {
    label: 'Outlets',
    commands: { set: { safety: 'confirm-off-when-critical', description: 'Turn one outlet on or off' } },
    requires: [],
  },
  acInput: {
    label: 'AC input',
    commands: {},
    requires: ['grid.present'],
  },
  'weather.forecast': {
    label: 'Weather forecast',
    commands: {},
    requires: [],
  },
} as const satisfies Record<string, CapabilitySpec>;

export type CapabilityName = keyof typeof CAPABILITIES;

export const CAPABILITY_NAMES = Object.keys(CAPABILITIES) as CapabilityName[];

/** The implementation each capability name stands for. */
export type CapabilityImpl = {
  switch: SwitchCapability;
  powerMeter: PowerMeterCapability;
  battery: BatteryCapability;
  outlets: OutletsCapability;
  acInput: AcInputCapability;
  'weather.forecast': WeatherForecastCapability;
};

export const isCapability = (name: string): name is CapabilityName => Object.hasOwn(CAPABILITIES, name);

/**
 * What a slot asks of a device — an automation's role: every capability in
 * `capabilities`, and at least one of `oneOf` when there is one ("a switch, or
 * one of a station's outlets").
 */
export type CapabilityNeed = { capabilities: readonly CapabilityName[]; oneOf?: readonly CapabilityName[] };

/** Whether a device offering these capabilities meets the need. */
export const meetsNeed = (need: CapabilityNeed, offered: readonly CapabilityName[]): boolean =>
  need.capabilities.every((capability) => offered.includes(capability)) && (!need.oneOf?.length || need.oneOf.some((capability) => offered.includes(capability)));

/** Whether a capability can change anything in the world. */
export const isActuating = (name: CapabilityName): boolean => Object.keys(CAPABILITIES[name].commands).length > 0;
