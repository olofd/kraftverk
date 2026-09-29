import type { StandardMeaningId } from './meanings.ts';
import type { ValueType } from './values.ts';

/**
 * Capabilities: what a part of a device can do or report, named by what it is
 * rather than by what one installation uses it for (docs/ARCHITECTURE.md §4.1).
 *
 * A plug offers `switch` — not "grid relay": that it feeds a station's AC input
 * is a fact about the house, recorded as a link (§4.4), and the same plug could
 * as well switch a heater. Automations and the gateway ask for "a part that can
 * switch", and never for a product.
 *
 * A capability is declared the way a Matter cluster is: the attributes it
 * binds, each to a standard meaning; the commands it accepts, with typed
 * arguments, a safety level and the attribute each one sets; and the queries
 * it answers. Nothing implements it by hand: a session takes commands and
 * queries addressed to a part and a capability, and reports attributes whose
 * meanings the capability names. Its projections into Home Assistant and
 * Matter are in `standards.ts`; a new capability borrows a Matter cluster's
 * meaning and name where one exists, and is one reviewed addition here.
 */

/**
 * What a command came to.
 *
 * Accepted is not proof: the device took the command. Whether anything
 * physical happened is for the gateway to establish, by reading back what the
 * command sets and whatever the device's links add.
 */
export type CommandResult = { accepted: true } | { accepted: false; error: string };

/**
 * How careful the gateway must be with a command.
 *
 * - `safe` — carried out when asked.
 * - `confirm` — the caller must confirm, every time.
 * - `confirm-off-when-critical` — turning something off needs confirmation when
 *   it matters: the part feeds another device through a link, or is carrying a
 *   load. Turning it on, or off when nothing depends on it, does not.
 *
 * The gateway also applies read-only mode, dwell time and freshness to every
 * command, whatever its level (docs/ARCHITECTURE.md §4.6).
 */
export type CommandSafety = 'safe' | 'confirm' | 'confirm-off-when-critical';

/** One attribute of a capability: which standard meaning it is. Its unit and quantity are the meaning's. */
export type CapabilityAttribute = {
  means: StandardMeaningId;
  /** A part offering the capability must report it. */
  required?: boolean;
};

export type CapabilityCommand = {
  safety: CommandSafety;
  description: string;
  /** Its arguments, each a value of the one value system. */
  args: Readonly<Record<string, ValueType>>;
  /**
   * Which of the capability's attributes each argument sets: `{ on: 'on' }`.
   * The gateway verifies a command by reading these back until they agree.
   */
  sets: Readonly<Record<string, string>>;
};

/** Data a capability answers on request that is not a value now: a forecast. */
export type CapabilityQuery = {
  description: string;
  args: Readonly<Record<string, ValueType>>;
};

export type CapabilitySpec = {
  label: string;
  attributes: Readonly<Record<string, CapabilityAttribute>>;
  /** None means it only reports. */
  commands: Readonly<Record<string, CapabilityCommand>>;
  queries: Readonly<Record<string, CapabilityQuery>>;
};

export const CAPABILITIES = {
  switch: {
    label: 'Switch',
    attributes: { on: { means: 'switch.on', required: true } },
    commands: {
      set: { safety: 'confirm-off-when-critical', description: 'Turn it on or off', args: { on: { type: 'boolean' } }, sets: { on: 'on' } },
    },
    queries: {},
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
    queries: {},
  },
  battery: {
    label: 'Battery',
    attributes: { soc: { means: 'battery.soc', required: true }, capacity: { means: 'battery.capacity' } },
    commands: {},
    queries: {},
  },
  acInput: {
    label: 'AC input',
    attributes: { present: { means: 'grid.present', required: true }, watts: { means: 'power.in.ac' } },
    commands: {},
    queries: {},
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

export const isCapability = (name: string): name is CapabilityName => Object.hasOwn(CAPABILITIES, name);

/** A capability's declaration, typed wide enough to walk. */
export const capabilitySpec = (name: CapabilityName): CapabilitySpec => CAPABILITIES[name];

/** The standard meanings a part offering this capability must report. */
export const requiredMeanings = (name: CapabilityName): StandardMeaningId[] =>
  Object.values(capabilitySpec(name).attributes)
    .filter((attribute) => attribute.required)
    .map((attribute) => attribute.means);

/** Whether a capability can change anything in the world. */
export const isActuating = (name: CapabilityName): boolean => Object.keys(capabilitySpec(name).commands).length > 0;

/**
 * Whether a part must say it offers a capability — it takes commands or
 * answers queries — rather than show it by the meanings of its attributes.
 */
export const mustBeOffered = (name: CapabilityName): boolean =>
  isActuating(name) || Object.keys(capabilitySpec(name).queries).length > 0 || requiredMeanings(name).length === 0;

/**
 * What a slot asks of a part — an automation's role: every capability in
 * `capabilities`, and at least one of `oneOf` when there is one.
 */
export type CapabilityNeed = { capabilities: readonly CapabilityName[]; oneOf?: readonly CapabilityName[] };

/** Whether a part offering these capabilities meets the need. */
export const meetsNeed = (need: CapabilityNeed, offered: readonly CapabilityName[]): boolean =>
  need.capabilities.every((capability) => offered.includes(capability)) && (!need.oneOf?.length || need.oneOf.some((capability) => offered.includes(capability)));
