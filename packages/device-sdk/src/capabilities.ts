import type { EventLevel } from './description.ts';
import type { StandardMeaningId } from './meanings.ts';
import type { Unit } from './units.ts';
import type { ScalarValue, ScalarValueType, ValueOf, ValueType } from './values.ts';

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
 * arguments, what makes one consequential and the attribute each one sets;
 * the queries it answers, with the type of the answer; and the events a part
 * offering it may raise. Nothing implements it by hand: a session takes
 * commands and queries addressed to a part and a capability, and reports
 * attributes whose meanings the capability names. Its projections into Home
 * Assistant and Matter are in `standards.ts`; a new capability borrows a
 * Matter cluster's meaning and names where one exists, and is one reviewed
 * addition here.
 *
 * The library is the shared vocabulary. A package may declare capabilities of
 * its own, in the same shape, namespaced by its type (`acme.plug.childLock`),
 * in its description: the gateway, the app and the contract treat them like
 * any other, but they have no projection into the standards and no place in
 * automations that work across types until they are promoted here.
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
 * A number the home decides, that a declaration names rather than fixes. The
 * capability says what is consequential — turning off what carries a load —
 * and the home says how much a load is: a night light at 6 W is not a
 * freezer. Each has the value it takes until someone changes it.
 */
export type PolicyValueSpec = { label: string; description: string; unit: Unit; default: number; min: number; max: number };

export const POLICY_VALUES = {
  loadWatts: {
    label: 'A load worth confirming',
    description: 'Turning off something that draws more than this asks first.',
    unit: 'W',
    default: 5,
    min: 0,
    max: 10_000,
  },
  // What a store is kept for — a power cut — is the home's to say; none is set for it (docs/SHARED-PARTS-AND-RESERVE.md).
  reserveSoc: {
    label: 'A reserve to keep',
    description: 'Automations and assistants do not switch on what drains a battery below this, and you are asked first. 0: no reserve.',
    unit: '%',
    default: 0,
    min: 0,
    max: 100,
  },
} as const satisfies Record<string, PolicyValueSpec>;

export type PolicyValueName = keyof typeof POLICY_VALUES;

export const isPolicyValueName = (name: string): name is PolicyValueName => Object.hasOwn(POLICY_VALUES, name);

/** A bound in a condition: a number, or a policy value by name. */
export type Threshold = number | { policy: PolicyValueName };

/** What the home has set, by name; what it has not set takes its default. */
export type PolicyValues = Readonly<Partial<Record<PolicyValueName, number>>>;

export const thresholdOf = (threshold: Threshold, values: PolicyValues = {}): number =>
  typeof threshold === 'number' ? threshold : (values[threshold.policy] ?? POLICY_VALUES[threshold.policy].default);

/** Something true of a part now, by meaning: `{ means: 'power', above: { policy: 'loadWatts' } }` — it is carrying a load. */
export type PartCondition = {
  means: StandardMeaningId;
  above?: Threshold;
  below?: Threshold;
  is?: ScalarValue;
};

/**
 * What makes a command consequential — worth a person's explicit "yes" — as a
 * declaration the gateway evaluates, so the gateway knows no domain:
 *
 * - `when` — the arguments that make it one: `{ arg: 'on', is: false }`,
 *   turning something off. Absent: every call.
 * - `if` — and any of these is true of the part now: it is carrying a load.
 *   Being the source of a link whose kind says so (`LinkKindSpec.consequential`)
 *   counts too: cutting what feeds a station. Absent: always, once `when`
 *   matches.
 *
 * The gateway also applies read-only mode, dwell time and freshness to every
 * command, consequential or not (docs/ARCHITECTURE.md §4.6).
 */
export type Consequence = {
  when?: { arg: string; is: ScalarValue };
  if?: readonly PartCondition[];
};

/** One attribute of a capability: which standard meaning it is. Its unit and quantity are the meaning's. */
export type CapabilityAttribute = {
  means: StandardMeaningId;
  /** A part offering the capability must report it. */
  required?: boolean;
};

export type CapabilityCommand = {
  description: string;
  /** Its arguments, each a scalar of the one value system. */
  args: Readonly<Record<string, ScalarValueType>>;
  /**
   * Which of the capability's attributes each argument sets: `{ on: 'on' }`.
   * The gateway verifies a command by reading these back until they agree.
   */
  sets: Readonly<Record<string, string>>;
  /** When it needs a person to confirm it: never, when absent; `'always'`; or as declared. */
  consequential?: Consequence | 'always';
  /**
   * When it drains the store behind its part — `{ when: { arg: 'on', is: true } }`,
   * switching a load on. On a part whose energy role is `load`, of a device
   * with a `storage` part, the gateway keeps the home's reserve (`reserveSoc`)
   * for it: below it, refused to automations and assistants, asked of a person.
   */
  drains?: { when: { arg: string; is: ScalarValue } };
};

/** Data a capability answers on request that is not a value now: a forecast. */
export type CapabilityQuery = {
  description: string;
  args: Readonly<Record<string, ScalarValueType>>;
  /** What it answers, in the value system: checked by the contract suite, and what a rule reads. */
  answer: ValueType;
};

/** Something a part offering the capability may say happened: mains lost. Declared again, with its part, in the description of a device that raises it. */
export type CapabilityEvent = { label: string; level: EventLevel; description: string };

export type CapabilitySpec = {
  label: string;
  attributes: Readonly<Record<string, CapabilityAttribute>>;
  /** None means it only reports. */
  commands: Readonly<Record<string, CapabilityCommand>>;
  queries: Readonly<Record<string, CapabilityQuery>>;
  events?: Readonly<Record<string, CapabilityEvent>>;
};

/** One hour of a forecast, as `weather.forecast` answers it. */
const FORECAST_HOUR = {
  type: 'object',
  fields: {
    /** The hour it is about — not when it was forecast. */
    at: { type: 'timestamp' },
    temperature: { type: 'number', unit: '°C' },
    cloudCover: { type: 'number', unit: '%', min: 0, max: 100 },
    precipitation: { type: 'number', unit: 'mm', min: 0 },
    irradiance: { type: 'number', unit: 'W/m²', min: 0 },
  },
  required: ['at'],
} as const satisfies ValueType;

export const CAPABILITIES = {
  switch: {
    label: 'Switch',
    attributes: { on: { means: 'on', required: true } },
    commands: {
      set: {
        description: 'Turn it on or off',
        args: { on: { type: 'boolean' } },
        sets: { on: 'on' },
        // Turning off what carries a load, or what feeds another device, is a deliberate act. How much is a load is the home's to say.
        consequential: { when: { arg: 'on', is: false }, if: [{ means: 'power', above: { policy: 'loadWatts' } }] },
        // Switching on a station's outlet runs it from its battery: the home's reserve is kept for it.
        drains: { when: { arg: 'on', is: true } },
      },
    },
    queries: {},
  },
  powerMeter: {
    label: 'Power meter',
    // Matter's ElectricalPowerMeasurement and ElectricalEnergyMeasurement names.
    attributes: {
      activePower: { means: 'power', required: true },
      voltage: { means: 'voltage' },
      activeCurrent: { means: 'current' },
      frequency: { means: 'frequency' },
      energyImported: { means: 'energy' },
    },
    commands: {},
    queries: {},
  },
  battery: {
    label: 'Battery',
    attributes: { soc: { means: 'charge', required: true }, capacity: { means: 'capacity' } },
    commands: {},
    queries: {},
  },
  acInput: {
    label: 'AC input',
    attributes: { present: { means: 'mainsPresent', required: true }, activePower: { means: 'mainsInput' } },
    commands: {},
    queries: {},
    events: {
      'mains.lost': { label: 'Mains lost', level: 'warn', description: 'Mains power went away: what it supplies runs from its battery, if it has one.' },
      'mains.restored': { label: 'Mains back', level: 'info', description: 'Mains power came back.' },
    },
  },
  energyPrice: {
    label: 'Energy price',
    // What electricity costs now, and where this hour stands among the day's.
    attributes: { now: { means: 'price', required: true }, rank: { means: 'priceRank' } },
    commands: {},
    queries: {},
  },
  'weather.forecast': {
    label: 'Weather forecast',
    attributes: {},
    commands: {},
    queries: {
      hourly: {
        description: 'The forecast, hour by hour, from the hour now',
        args: { hours: { type: 'number', min: 1, max: 168, integer: true } },
        answer: { type: 'list', of: FORECAST_HOUR },
      },
    },
  },
  location: {
    label: 'Location',
    // Where it is on the Earth, and how sure: a phone, a scooter, a tag. How far it is from home is the automation language's `distance`.
    attributes: { position: { means: 'position', required: true } },
    commands: {},
    queries: {},
  },
} as const satisfies Record<string, CapabilitySpec>;

/** A capability in the library: the shared vocabulary. */
export type CapabilityName = keyof typeof CAPABILITIES;

/** Any capability: the library's, or one a package declares, namespaced by its type. */
export type CapabilityId = CapabilityName | (string & {});

export const CAPABILITY_NAMES = Object.keys(CAPABILITIES) as CapabilityName[];

export const isCapability = (name: string): name is CapabilityName => Object.hasOwn(CAPABILITIES, name);

/** A library capability's declaration, typed wide enough to walk. */
export const capabilitySpec = (name: CapabilityName): CapabilitySpec => CAPABILITIES[name];

/** The queries a library capability answers, by name. */
export type QueryName<Name extends CapabilityName> = keyof (typeof CAPABILITIES)[Name]['queries'] & string;

/** A library query's answer, as TypeScript sees it: what a function reads, with no cast. */
export type QueryAnswer<Name extends CapabilityName, Query extends QueryName<Name>> =
  (typeof CAPABILITIES)[Name]['queries'][Query] extends { answer: infer Answer extends ValueType } ? ValueOf<Answer> : never;

/** The standard meanings a part offering this capability must report. */
export const requiredMeanings = (spec: CapabilitySpec): StandardMeaningId[] =>
  Object.values(spec.attributes)
    .filter((attribute) => attribute.required)
    .map((attribute) => attribute.means);

/** Whether a capability can change anything in the world. */
export const isActuating = (spec: CapabilitySpec): boolean => Object.keys(spec.commands).length > 0;

/**
 * Whether a part must say it offers a capability — it takes commands or
 * answers queries — rather than show it by the meanings of its attributes.
 */
export const mustBeOffered = (spec: CapabilitySpec): boolean =>
  isActuating(spec) || Object.keys(spec.queries).length > 0 || requiredMeanings(spec).length === 0;

/**
 * What a slot asks of a part — an automation's role: every capability in
 * `capabilities`, and at least one of `oneOf` when there is one. Library
 * capabilities only: a role is filled across types.
 */
export type CapabilityNeed = { capabilities: readonly CapabilityName[]; oneOf?: readonly CapabilityName[] };

/** Whether a part offering these capabilities meets the need. */
export const meetsNeed = (need: CapabilityNeed, offered: readonly string[]): boolean =>
  need.capabilities.every((capability) => offered.includes(capability)) && (!need.oneOf?.length || need.oneOf.some((capability) => offered.includes(capability)));

/** Whether a part's current readings make a condition true; null when what it reads is not known. */
export function conditionHolds(condition: PartCondition, value: ScalarValue | undefined, values: PolicyValues = {}): boolean | null {
  if (value === null || value === undefined) return null;
  if (condition.is !== undefined && value !== condition.is) return false;
  if (condition.above !== undefined && !(typeof value === 'number' && value > thresholdOf(condition.above, values))) return false;
  if (condition.below !== undefined && !(typeof value === 'number' && value < thresholdOf(condition.below, values))) return false;
  return true;
}
