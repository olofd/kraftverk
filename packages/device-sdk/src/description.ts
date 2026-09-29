import {
  CAPABILITIES,
  CAPABILITY_NAMES,
  isCapability,
  mustBeOffered,
  requiredMeanings,
  type CapabilityId,
  type CapabilitySpec,
} from './capabilities.ts';
import { QUANTITIES, STANDARD_NAMESPACES, STATE_CLASSES, standardMeaning, type Quantity, type StateClass } from './meanings.ts';
import type { ConfigField } from './schema.ts';
import { checkValue, isScalarType, valueTypeProblems, type ScalarValueType, type Value, type ValueType } from './values.ts';

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
  forecast: { label: 'Forecast', icon: 'cloud' },
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
  /** What a number is a quantity of. On/off values are booleans, and say nothing here. */
  quantity?: Quantity;
  /**
   * What it means: a standard meaning (`battery.soc`) — whose unit, quantity and
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
 */
export type Reading = { key: string; value: Value; at: string };

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

export const attributesOf = (description: DeviceDescription, part: string): AttributeSpec[] =>
  description.attributes.filter((attribute) => partOf(attribute) === part);

/** What a number is a quantity of: declared, or the standard meaning's. Nothing that is not a number has one. */
export function quantityOf(attribute: Pick<AttributeSpec, 'quantity' | 'means' | 'value'>): Quantity | null {
  if (attribute.value.type !== 'number') return null;
  if (attribute.quantity) return attribute.quantity;
  const standard = attribute.means ? standardMeaning(attribute.means) : null;
  return standard?.type === 'number' ? standard.quantity : null;
}

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
export function isCurrent(attribute: Pick<AttributeSpec, 'currentFor' | 'stateClass' | 'value'>, reading: Pick<Reading, 'at' | 'value'> | null | undefined, now = Date.now()): boolean {
  if (!reading || reading.value === null) return false;
  const at = Date.parse(reading.at);
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

/** A setting as the form language draws it: its value type, titled by its label. Null for one with structure. */
export function settingField(attribute: AttributeSpec): ConfigField | null {
  const presented = { title: attribute.label, ...(attribute.description ? { description: attribute.description } : {}) };
  const type = attribute.value;
  switch (type.type) {
    case 'number':
      return { ...type, ...presented };
    case 'boolean':
      return { type: 'boolean', ...presented };
    case 'enum':
      return { type: 'enum', options: type.options, ...presented };
    case 'string':
      return { type: 'string', ...presented };
    case 'timestamp':
      return { type: 'timestamp', ...presented };
    default:
      return null;
  }
}

/** Checks a value an attribute reports or is given against the attribute's type. */
export const checkAttributeValue = (attribute: AttributeSpec, value: unknown) => checkValue(attribute.value, value);

// --- checking a description --------------------------------------------------------

const PART_ID = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAMESPACED = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+\.[a-z][A-Za-z0-9]*$/;
const ICON = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Every problem with one of a type's own capabilities: the library's rules, and its name. */
function capabilityProblems(id: string, spec: CapabilitySpec, typeId: string): string[] {
  const problems: string[] = [];
  const where = `capability "${id}"`;
  if (isCapability(id)) return [`${where} is in the library; a type declares only its own`];
  if (!id.startsWith(`${typeId}.`) || !NAMESPACED.test(id)) problems.push(`${where} must be namespaced by the type: "${typeId}.something"`);
  if (!spec.label?.trim()) problems.push(`${where} has no label`);
  for (const [name, attribute] of Object.entries(spec.attributes ?? {})) {
    if (!standardMeaning(attribute.means)) problems.push(`${where} attribute "${name}" means "${attribute.means}", which is not a standard meaning`);
  }
  for (const [name, command] of Object.entries(spec.commands ?? {})) {
    for (const [arg, type] of Object.entries(command.args ?? {})) problems.push(...valueTypeProblems(`${where} command "${name}" argument "${arg}"`, type));
    for (const [arg, attribute] of Object.entries(command.sets ?? {})) {
      if (!(arg in (command.args ?? {}))) problems.push(`${where} command "${name}" sets from "${arg}", which it does not take`);
      if (!(attribute in (spec.attributes ?? {}))) problems.push(`${where} command "${name}" sets "${attribute}", which it does not have`);
    }
  }
  for (const [name, query] of Object.entries(spec.queries ?? {})) problems.push(...valueTypeProblems(`${where} query "${name}" answer`, query.answer));
  return problems;
}

/**
 * Every problem with a description, not just the first — the static half of
 * the device model's contract. `typeId` names the type's own namespace, for
 * its own meanings and capabilities.
 */
export function validateDescription(description: DeviceDescription, typeId = 'brand.model'): string[] {
  const problems: string[] = [];
  const problem = (message: string) => problems.push(message);

  // --- its own capabilities ---------------------------------------------------------
  for (const [id, spec] of Object.entries(description.capabilities ?? {})) problems.push(...capabilityProblems(id, spec, typeId));

  // --- parts --------------------------------------------------------------------
  const parts = partsOf(description);
  const partIds = new Set<string>();
  for (const part of description.parts ?? []) {
    if (!PART_ID.test(part.id ?? '')) problem(`part id "${part.id}" must be lowercase words, dotted: "outlet.ac", "pack.1"`);
    if (partIds.has(part.id)) problem(`part "${part.id}" is declared twice`);
    partIds.add(part.id);
    if (!part.label?.trim() && part.id !== MAIN_PART) problem(`part "${part.id}" has no label`);
    if (!isStandardPartKind(part.kind ?? '')) {
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(part.kind ?? '')) problem(`part "${part.id}" is a "${part.kind}", which is not a kind; a kind of the type's own is namespaced, like "${typeId.split('.')[0]}.hopper"`);
      else if (!part.icon) problem(`part "${part.id}" is a kind of the type's own, "${part.kind}", and needs an icon`);
    }
    if (part.icon !== undefined && !ICON.test(part.icon)) problem(`part "${part.id}" has an icon "${part.icon}", which is not a Feather icon name`);
    if (part.energy && !['source', 'storage', 'load'].includes(part.energy.role)) problem(`part "${part.id}" has an unknown energy role "${part.energy.role}"`);
  }
  partIds.add(MAIN_PART);
  for (const part of parts) {
    if (part.parent !== undefined && !partIds.has(part.parent)) problem(`part "${part.id}" belongs to "${part.parent}", which is not a part`);
    for (const name of part.offers ?? []) {
      const spec = capabilityIn(description, name);
      if (!spec) {
        problem(`part "${part.id}" offers "${name}", which is neither in the library nor declared by the type`);
        continue;
      }
      for (const meaning of requiredMeanings(spec)) {
        if (!attributeMeaning(description, part.id, meaning)) problem(`part "${part.id}" offers "${name}", which needs an attribute meaning "${meaning}"`);
      }
    }
  }
  const otherParts = [...partIds].filter((id) => id !== MAIN_PART);

  // --- attributes ----------------------------------------------------------------
  const keys = new Set<string>();
  const primaries = new Map<string, number>();
  const meanings = new Set<string>();
  for (const attribute of description.attributes ?? []) {
    const where = `attribute "${attribute.key}"`;
    const part = partOf(attribute);
    if (!KEY.test(attribute.key ?? '')) problem(`an attribute has no usable key ("${attribute.key}")`);
    if (keys.has(attribute.key)) problem(`${where} is declared twice`);
    keys.add(attribute.key);
    if (!partIds.has(part)) problem(`${where} belongs to "${part}", which is not a part`);
    else if (part !== MAIN_PART && !attribute.key?.startsWith(`${part}.`)) problem(`${where} is on "${part}", so its key begins "${part}.": "${part}.${attribute.key}"`);
    else if (part === MAIN_PART) {
      const claimed = otherParts.find((id) => attribute.key?.startsWith(`${id}.`));
      if (claimed) problem(`${where} is on main, but its key begins with the part "${claimed}"`);
    }
    if (!attribute.label?.trim()) problem(`${where} has no label`);
    problems.push(...valueTypeProblems(where, attribute.value));
    if (attribute.category === 'primary') primaries.set(part, (primaries.get(part) ?? 0) + 1);
    if (attribute.currentFor !== undefined && !(Number.isInteger(attribute.currentFor) && attribute.currentFor > 0)) problem(`${where} is current for ${attribute.currentFor} ms; a whole number of milliseconds above zero`);

    if (attribute.stateClass !== undefined) {
      if (!STATE_CLASSES.includes(attribute.stateClass)) problem(`${where} has an unknown state class "${attribute.stateClass}"`);
      else if (attribute.value?.type !== 'number') problem(`${where} has a state class, which only a number can have`);
    }
    if (attribute.quantity !== undefined) {
      if (attribute.value?.type !== 'number') problem(`${where} names a quantity, which only a number has`);
      else if (!QUANTITIES.includes(attribute.quantity)) problem(`${where} has an unknown quantity "${attribute.quantity}"`);
    }
    if (attribute.dangerous && attribute.access !== 'write') problem(`${where} is dangerous but cannot be written; a command's danger is its capability's`);
    if (attribute.category === 'config' && attribute.access !== 'write') problem(`${where} is a setting that cannot be written`);
    if (attribute.access === 'write' && (attribute.value?.type === 'list' || attribute.value?.type === 'object')) problem(`${where} is a setting with structure; a setting is one value`);

    if (attribute.means === undefined) continue;
    const meaningInPart = `${part}:${attribute.means}`;
    if (meanings.has(meaningInPart)) problem(`part "${part}" has two attributes meaning "${attribute.means}"`);
    meanings.add(meaningInPart);

    const standard = standardMeaning(attribute.means);
    if (standard?.type === 'boolean') {
      if (attribute.value?.type !== 'boolean') problem(`${where} means ${attribute.means}, which is on or off, but is not a boolean`);
    } else if (standard) {
      const standardState = standard.stateClass ?? 'measurement';
      if (attribute.value?.type !== 'number' || (attribute.value.unit ?? '') !== standard.unit || quantityOf(attribute) !== standard.quantity) {
        problem(`${where} means ${attribute.means}, which is ${standard.quantity} in "${standard.unit}"`);
      } else if ((attribute.stateClass ?? 'measurement') !== standardState) {
        problem(`${where} means ${attribute.means}, which is ${standardState}, but is declared ${attribute.stateClass ?? 'measurement'}`);
      }
    } else {
      const namespace = attribute.means.split('.')[0]!;
      if (!attribute.means.includes('.') || STANDARD_NAMESPACES.includes(namespace)) {
        problem(`${where} means "${attribute.means}", which is not a standard meaning; a type's own are namespaced by the type, like "${typeId.split('.').pop()}.${attribute.key}"`);
      }
    }
  }
  for (const [part, count] of primaries) if (count > 1) problem(`part "${part}" has ${count} primary attributes; one leads its card`);

  // --- events --------------------------------------------------------------------
  const events = new Set<string>();
  for (const event of description.events ?? []) {
    if (!KEY.test(event.id ?? '')) problem(`an event has no usable id ("${event.id}")`);
    if (events.has(event.id)) problem(`event "${event.id}" is declared twice`);
    events.add(event.id);
    if (!event.label?.trim()) problem(`event "${event.id}" has no label`);
    if (!['info', 'warn', 'error'].includes(event.level)) problem(`event "${event.id}" has an unknown level "${event.level}"`);
    const part = event.part ?? MAIN_PART;
    if (!partIds.has(part)) problem(`event "${event.id}" belongs to "${part}", which is not a part`);
    // An event a capability of the part declares is that event: the same level, whatever the device calls it.
    for (const capability of partIds.has(part) ? capabilitiesOf(description, part) : []) {
      const standard = capabilityIn(description, capability)?.events?.[event.id];
      if (standard && standard.level !== event.level) problem(`event "${event.id}" is ${capability}'s, which is ${standard.level}, but is declared ${event.level}`);
    }
    for (const [name, type] of Object.entries(event.data ?? {})) problems.push(...valueTypeProblems(`event "${event.id}" data "${name}"`, type));
  }

  return problems;
}
