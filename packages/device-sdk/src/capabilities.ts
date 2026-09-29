import type { StandardMetricId } from './telemetry.ts';
import type { ValueType } from './values.ts';

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

/**
 * One attribute of a capability: which standard meaning it is. Its unit and
 * kind are the meaning's (`STANDARD_METRICS`), so they are never declared twice.
 */
export type CapabilityAttribute = {
  means: StandardMetricId;
  /** A device offering the capability must report it. */
  required?: boolean;
};

/** A command a capability accepts. */
export type CapabilityCommand = {
  safety: CommandSafety;
  description: string;
  /** Its arguments, each a value of the one value system. */
  args: Readonly<Record<string, ValueType>>;
  /**
   * Which of the capability's attributes each argument sets: `{ on: 'on' }`.
   * The gateway verifies a command by reading these back until they agree,
   * so a command that sets nothing it can read back cannot be verified.
   */
  sets?: Readonly<Record<string, string>>;
};

/** Data a capability answers on request that is not a value now: a forecast. */
export type CapabilityQuery = {
  description: string;
  args: Readonly<Record<string, ValueType>>;
};

/**
 * A capability, declared the way a Matter cluster is: the attributes it binds,
 * the commands it accepts and the queries it answers (docs/ARCHITECTURE.md §8
 * step 23). Its projections into Home Assistant and Matter are in
 * `standards.ts`; a new capability borrows a Matter cluster's meaning and name
 * where one exists.
 */
export type CapabilitySpec = {
  label: string;
  attributes: Readonly<Record<string, CapabilityAttribute>>;
  /** None means it only reports. */
  commands: Readonly<Record<string, CapabilityCommand>>;
  queries?: Readonly<Record<string, CapabilityQuery>>;
};

const ON_OFF: ValueType = { type: 'boolean' };

export const CAPABILITIES = {
  switch: {
    label: 'Switch',
    attributes: { on: { means: 'switch.on', required: true } },
    commands: {
      set: { safety: 'confirm-off-when-critical', description: 'Turn it on or off', args: { on: ON_OFF }, sets: { on: 'on' } },
    },
  },
  powerMeter: {
    label: 'Power meter',
    attributes: {
      watts: { means: 'power.draw', required: true },
      volts: { means: 'voltage.ac' },
      amps: { means: 'current.ac' },
      hz: { means: 'frequency.ac' },
      kwh: { means: 'energy.total' },
    },
    commands: {},
  },
  battery: {
    label: 'Battery',
    attributes: { soc: { means: 'battery.soc', required: true }, capacity: { means: 'battery.capacity' } },
    commands: {},
  },
  /**
   * Several switched outputs on one device, as a power station has. Retires
   * when a device is made of parts (step 26): each outlet becomes a part with
   * a `switch` of its own, and this special case goes.
   */
  outlets: {
    label: 'Outlets',
    attributes: {},
    commands: {
      set: {
        safety: 'confirm-off-when-critical',
        description: 'Turn one outlet on or off',
        args: { outlet: { type: 'string' }, on: ON_OFF },
      },
    },
  },
  acInput: {
    label: 'AC input',
    attributes: { present: { means: 'grid.present', required: true }, watts: { means: 'power.in.ac' } },
    commands: {},
  },
  'weather.forecast': {
    label: 'Weather forecast',
    attributes: {},
    commands: {},
    queries: {
      hourly: { description: 'The forecast, hour by hour', args: { hours: { type: 'number', min: 1, max: 168, integer: true } } },
    },
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

/** The standard meanings a device offering this capability must report, so it can be charted and automated. */
export const requiredMeanings = (name: CapabilityName): StandardMetricId[] =>
  Object.values(CAPABILITIES[name].attributes as Readonly<Record<string, CapabilityAttribute>>)
    .filter((attribute) => attribute.required)
    .map((attribute) => attribute.means);

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
