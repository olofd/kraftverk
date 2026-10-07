import type { Unit } from './units.ts';
import { CAPABILITIES, CAPABILITY_NAMES, isCapability, mustBeOffered, requiredMeanings, type CapabilityId, type CapabilitySpec } from './capabilities.ts';
import { standardMeaning, type StateClass } from './meanings.ts';
import { quantitySpec, type Quantity } from './quantities.ts';
import { checkValue, isScalarType, type ScalarValueType, type Value, type ValueType } from './values.ts';

/**
 * What a device is, as data (docs/ARCHITECTURE.md §4.5).
 *
 * A device is made of **parts**, as a Matter node is made of endpoints: `main`,
 * and whatever it has several of — outlets, inputs, battery packs. Each part
 * has **attributes**: what it reports, and what it remembers and can be told
 * (a setting is an attribute that can be written). A part **offers
 * capabilities**: those whose meanings its attributes carry, and the actuating
 * ones it says it takes commands for. A device also raises **events**.
 *
 * Everything is addressed by part: a command by part, capability and command;
 * an attribute by its key, which begins with its part's id (`pack.1.soc`), so
 * the key alone says where a value is and history can be asked for per part.
 *
 * The description is what the app draws, the gateway checks, automations ask
 * for, history is kept by and the bridges publish. A type declares it; a
 * session may report its own when the device decides — a pack plugged in is a
 * new part — so a standard's devices, which describe themselves, fit the same
 * model as a package that knows its product by heart.
 */

/** The part every device has: the device itself. */
export const MAIN_PART = 'main';

/**
 * The kinds of part, for drawing them — never for behaviour, which comes from
 * capabilities. A curated list, each with a Feather icon, grown by review like
 * the capabilities; a kind of a package's own is namespaced (`acme.hopper`)
 * and its part names its icon.
 */
export const PART_KINDS = {
  device: { label: 'Device', icon: 'box' },
  outlet: { label: 'Outlet', icon: 'power' },
  input: { label: 'Input', icon: 'log-in' },
  output: { label: 'Output', icon: 'log-out' },
  battery: { label: 'Battery', icon: 'battery' },
  sensor: { label: 'Sensor', icon: 'thermometer' },
  meter: { label: 'Meter', icon: 'activity' },
  light: { label: 'Light', icon: 'sun' },
  channel: { label: 'Channel', icon: 'git-commit' },
  button: { label: 'Button', icon: 'circle' },
  cover: { label: 'Cover', icon: 'columns' },
  valve: { label: 'Valve', icon: 'droplet' },
  lock: { label: 'Lock', icon: 'lock' },
  fan: { label: 'Fan', icon: 'wind' },
  place: { label: 'Place', icon: 'map-pin' },
  other: { label: 'Part', icon: 'box' },
} as const satisfies Record<string, { label: string; icon: string }>;

export type StandardPartKind = keyof typeof PART_KINDS;

/** What a part is: a kind from the list, or one of a package's own, namespaced. */
export type PartKind = StandardPartKind | `${string}.${string}`;

export const isStandardPartKind = (kind: string): kind is StandardPartKind => Object.hasOwn(PART_KINDS, kind);

/** Where a part sits in the flow of energy, so a flow can be drawn for a device nobody wrote a screen for. */
export type EnergyRole = 'source' | 'storage' | 'load';

export type Part = {
  /** Stable forever, unique in the device: `main`, `outlet.ac`, `pack.1`. */
  id: string;
  label: string;
  kind: PartKind;
  /** A Feather icon, when the kind's own will not do. Required for a kind of a package's own. */
  icon?: string;
  /** Its place in the flow of energy, for a part that has one. A lock has none. */
  energy?: { role: EnergyRole };
  /** The part this one belongs to, when parts nest. */
  parent?: string;
  /**
   * Capabilities this part offers beyond what its attributes show: those with
   * commands or queries, which a part can report the meaning of without taking
   * the command (a relay whose state is read but never switched).
   */
  offers?: readonly CapabilityId[];
};

/** The icon a part is drawn with: its own, or its kind's. */
export const partIcon = (part: Pick<Part, 'kind' | 'icon'>): string =>
  part.icon ?? (isStandardPartKind(part.kind) ? PART_KINDS[part.kind].icon : PART_KINDS.other.icon);

export type AttributeAccess = 'read' | 'write';

/**
 * Where an attribute is shown. `primary` leads its part's card; `config` is a
 * setting, shown under Settings; `diagnostic` is kept and charted but off the
 * dashboard — signal strength, an internal temperature.
 */
export type AttributeCategory = 'primary' | 'config' | 'diagnostic';

export type AttributeSpec = {
  /**
   * What history is kept under. Unique in the device, and beginning with its
   * part's id when it is not on `main`: `pack.1.soc`, `outlet.ac.on`.
   */
  key: string;
  /** The part it belongs to; `main` when absent. */
  part?: string;
  label: string;
  description?: string;
  value: ValueType;
  /** What a number — or a value of a quantity's shape, a position — is a quantity of. On/off values are booleans, and say nothing here. */
  quantity?: Quantity;
  /**
   * What it means: a standard meaning (`charge`) — whose unit, quantity and
   * state class it must then keep — or one namespaced by the type
   * (`station.minutesToFull`).
   */
  means?: string;
  stateClass?: StateClass;
  /**
   * How long a value stays current after the device observed it, in
   * milliseconds: past this, history does not record it, the gateway does not
   * act on it and the app shows it as old. From the state class when absent
   * (`currentForOf`); a forecast, fetched every half hour, says an hour.
   */
  currentFor?: number;
  /** `write` is a setting the device remembers and can be told. `read` when absent. */
  access?: AttributeAccess;
  category?: AttributeCategory;
  /** A heading to group it under, on generic screens: "Charging". */
  section?: string;
  /** Physical and consequential: a person confirms it, an automation never can. */
  dangerous?: boolean;
  /** What happens, in one line, shown before changing it. */
  consequence?: string;
  /** Kept in history. True when absent for numbers, on/offs and enums that are not settings. */
  history?: boolean;
};

export type EventLevel = 'info' | 'warn' | 'error';

/** Something that happens, rather than a value that is: an overload trip, a button press. */
export type EventSpec = {
  /** Unique in the device: `overload`, `button.pressed`. A capability's own (`mains.lost`) keeps the capability's level. */
  id: string;
  label: string;
  level: EventLevel;
  part?: string;
  description?: string;
  /** What it carries, each a scalar of the one value system. */
  data?: Readonly<Record<string, ScalarValueType>>;
};

/** Whose word a device's description is: its type's, for its config, or the device's own. */
export type DescriptionSource = 'type' | 'device';

export type DeviceDescription = {
  /** `main` is always there; declare it only to name it or give it a role. */
  parts?: readonly Part[];
  attributes: readonly AttributeSpec[];
  events?: readonly EventSpec[];
  /**
   * Capabilities of the type's own, namespaced by it (`acme.plug.childLock`), in
   * the library's shape: offered by its parts like any other.
   */
  capabilities?: Readonly<Record<string, CapabilitySpec>>;
};

/** What a device says about itself — Home Assistant's device information, Matter's Basic Information. */
export type DeviceInfo = {
  manufacturer?: string;
  model?: string;
  /** The model as the device codes it, when that differs from its name. */
  modelId?: string;
  serial?: string;
  hardware?: string;
  /** One or several firmware versions, by component: `{ main: '1.2', bms: '3.0' }`. */
  firmware?: Readonly<Record<string, string>>;
};

/**
 * A value an attribute holds, and when the device observed it — not when
 * anyone asked, and not what time the value is about: a forecast for 14:00
 * fetched at 09:30 was observed at 09:30.
 *
 * `confirmedAt`: when the device last said it still holds, later than it
 * observed it — a parked scooter's charge, reported yesterday, still standing
 * each time its cloud answers. It is current from then (`isCurrent`), while
 * `at` stays when it was said. Absent: the device has said nothing since.
 */
export type Reading = { key: string; value: Value; at: string; confirmedAt?: string };

/** The reading for one key, or null when the device has not reported it. */
export const readingOf = (readings: readonly Reading[], key: string): Reading | null =>
  readings.find((reading) => reading.key === key) ?? null;

// --- reading a description ------------------------------------------------------

export const partOf = (attribute: Pick<AttributeSpec, 'part'>): string => attribute.part ?? MAIN_PART;

const mainPart = (label = 'Device'): Part => ({ id: MAIN_PART, label, kind: 'device' });

/** Every part, `main` first, whether or not it was declared. */
export function partsOf(description: DeviceDescription, mainLabel?: string): Part[] {
  const declared = description.parts ?? [];
  const main = declared.find((part) => part.id === MAIN_PART) ?? mainPart(mainLabel);
  return [main, ...declared.filter((part) => part.id !== MAIN_PART)];
}

/**
 * A part as a person reads it, the one way everywhere — screens, steps,
 * sentences, the audit: "Garage station — AC outlets", or the device's own name
 * for its main part (or a part it no longer has).
 */
export const partName = (deviceName: string, part: string, label: string | null | undefined): string =>
  part === MAIN_PART || !label ? deviceName : `${deviceName} — ${label}`;

export const attributesOf = (description: DeviceDescription, part: string): AttributeSpec[] =>
  description.attributes.filter((attribute) => partOf(attribute) === part);

/**
 * What a value is a quantity of: declared, or the standard meaning's — for a
 * number, or a value with structure of a quantity's shape (a position).
 * Nothing else has one.
 */
export function quantityOf(attribute: Pick<AttributeSpec, 'quantity' | 'means' | 'value'>): Quantity | null {
  if (attribute.value.type !== 'number' && attribute.value.type !== 'object') return null;
  const standard = attribute.means ? standardMeaning(attribute.means) : null;
  const quantity = attribute.quantity ?? (standard && standard.type !== 'boolean' ? standard.quantity : null);
  // A number's quantity is a number's; a shape's, a shape's.
  return quantity && quantitySpec(quantity).value.type === attribute.value.type ? quantity : null;
}

/** The unit a number is in, or null: not a number, or one with no unit. */
export const unitIn = (attribute: Pick<AttributeSpec, 'value'>): Unit | null => (attribute.value.type === 'number' ? (attribute.value.unit ?? null) : null);

/** The unit a value is shown in: a number's own, or none. */
export const unitOf = (attribute: Pick<AttributeSpec, 'value'>): string => (attribute.value.type === 'number' ? (attribute.value.unit ?? '') : '');

/** How a number moves over time; none for anything that is not a number. */
export const stateClassOf = (attribute: Pick<AttributeSpec, 'stateClass' | 'value'>): StateClass | null =>
  attribute.value.type === 'number' ? (attribute.stateClass ?? 'measurement') : null;

/** How long a value stays current when its attribute does not say: two minutes for a value now, an hour for a running total. */
export const CURRENT_FOR_MS = { measurement: 2 * 60_000, total: 60 * 60_000 } as const;

/** How long a value of this attribute stays current after it was observed, in milliseconds. */
export const currentForOf = (attribute: Pick<AttributeSpec, 'currentFor' | 'stateClass' | 'value'>): number =>
  attribute.currentFor ?? (stateClassOf(attribute) === 'total' || stateClassOf(attribute) === 'total_increasing' ? CURRENT_FOR_MS.total : CURRENT_FOR_MS.measurement);

/**
 * Whether a reading is still current for its attribute, at `now`. A reading
 * that does not say when is not; nor is one that is not known.
 */
export function isCurrent(attribute: Pick<AttributeSpec, 'currentFor' | 'stateClass' | 'value'>, reading: Pick<Reading, 'at' | 'confirmedAt' | 'value'> | null | undefined, now = Date.now()): boolean {
  if (!reading || reading.value === null) return false;
  // Current from when it was last said to hold: observed, or confirmed since.
  const at = Math.max(Date.parse(reading.at), reading.confirmedAt ? Date.parse(reading.confirmedAt) : Number.NEGATIVE_INFINITY);
  return Number.isFinite(at) && now - at <= currentForOf(attribute);
}

/** The attribute that leads a part's card: the one marked primary, or its first. */
export const primaryOf = (description: DeviceDescription, part = MAIN_PART): AttributeSpec | null => {
  const own = attributesOf(description, part).filter((attribute) => attribute.category !== 'config');
  return own.find((attribute) => attribute.category === 'primary') ?? own[0] ?? null;
};

/**
 * Whether history keeps it: numbers, on/offs and enums that are not settings,
 * unless it says otherwise. A list or an object never: a sample is one value.
 */
export const keepsHistory = (attribute: Pick<AttributeSpec, 'history' | 'access' | 'value'>): boolean =>
  isScalarType(attribute.value) && (attribute.history ?? (attribute.access !== 'write' && ['number', 'boolean', 'enum'].includes(attribute.value.type)));

/** A capability's declaration: the library's, or one the description declares of its own. */
export const capabilityIn = (description: DeviceDescription, id: string): CapabilitySpec | null =>
  isCapability(id) ? CAPABILITIES[id] : (description.capabilities?.[id] ?? null);

/**
 * The capabilities a part offers: every library capability that is read-only
 * and whose required meanings its attributes carry, and every capability it
 * names in `offers`.
 */
export function capabilitiesOf(description: DeviceDescription, part: string): CapabilityId[] {
  const meanings = new Set(attributesOf(description, part).flatMap((attribute) => (attribute.means ? [attribute.means] : [])));
  const offers = partsOf(description).find((candidate) => candidate.id === part)?.offers ?? [];
  const derived = CAPABILITY_NAMES.filter((name) => {
    const spec = CAPABILITIES[name];
    return !offers.includes(name) && !mustBeOffered(spec) && requiredMeanings(spec).every((meaning) => meanings.has(meaning));
  });
  return [...offers.filter((id) => capabilityIn(description, id)), ...derived].sort((a, b) => order(a) - order(b));
}

/** Library capabilities in the library's order, a type's own after them. */
const order = (id: string): number => (isCapability(id) ? CAPABILITY_NAMES.indexOf(id) : CAPABILITY_NAMES.length);

/** Every capability any part offers — what a role in an automation asks of a whole device. */
export const deviceCapabilities = (description: DeviceDescription): CapabilityId[] => [
  ...new Set(partsOf(description).flatMap((part) => capabilitiesOf(description, part.id))),
];

/** The attribute on a part that carries a meaning, if it has one. */
export const attributeMeaning = (description: DeviceDescription, part: string, means: string): AttributeSpec | null =>
  attributesOf(description, part).find((attribute) => attribute.means === means) ?? null;

/** Checks a value an attribute reports or is given against the attribute's type. */
export const checkAttributeValue = (attribute: AttributeSpec, value: unknown) => checkValue(attribute.value, value);
