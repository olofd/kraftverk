import { CAPABILITIES, isCapability, requiredMeanings, type CapabilityName } from './capabilities.ts';
import { STANDARD_METRICS, STANDARD_NAMESPACES, STATE_CLASSES, type Quantity, type StandardMetricId, type StateClass } from './telemetry.ts';
import { checkValue, type Value, type ValueType } from './values.ts';

/**
 * What a device is, as data (docs/ARCHITECTURE.md §8 step 24).
 *
 * A device is made of **parts**, as a Matter node is made of endpoints: `main`,
 * and whatever it has several of — outlets, inputs, battery packs. Each part
 * has **attributes**: what it reports, and what it remembers and can be told
 * (a setting is an attribute that can be written). A part **offers
 * capabilities**: those whose meanings its attributes carry, and the actuating
 * ones it says it takes commands for. A device also raises **events**.
 *
 * The description is what the app draws, the gateway checks, automations ask
 * for, history is kept by and the bridges publish. A type declares it; a
 * session may report its own when the device decides — a pack plugged in is a
 * new part — so a standard's devices, which describe themselves, fit the same
 * model as a package that knows its product by heart.
 */

/** The part every device has: the device itself. */
export const MAIN_PART = 'main';

/** What a part is, for drawing it. Never behaviour: that comes from capabilities. */
export type PartKind = 'device' | 'outlet' | 'input' | 'output' | 'battery' | 'sensor' | 'light' | 'channel' | 'other';

/** Where a part sits in the flow of energy, so a flow can be drawn for a device nobody wrote a screen for. */
export type PartRole = 'source' | 'storage' | 'load';

export type Part = {
  /** Stable forever, unique in the device: `main`, `outlet.ac`, `pack.1`. */
  id: string;
  label: string;
  kind: PartKind;
  role?: PartRole;
  /** The part this one belongs to, when parts nest. */
  parent?: string;
  /**
   * Capabilities this part offers beyond what its attributes show: those with
   * commands or queries, which a part can report the meaning of without taking
   * the command (a relay whose state is read but never switched).
   */
  offers?: readonly CapabilityName[];
};

export type AttributeAccess = 'read' | 'write';

/**
 * Where an attribute is shown. `primary` leads its part's card; `config` is a
 * setting, shown under Settings; `diagnostic` is kept and charted but off the
 * dashboard — signal strength, an internal temperature.
 */
export type AttributeCategory = 'primary' | 'config' | 'diagnostic';

export type AttributeSpec = {
  /** What history is kept under. Stable forever once shipped, unique in the device. */
  key: string;
  /** The part it belongs to; `main` when absent. */
  part?: string;
  label: string;
  description?: string;
  value: ValueType;
  /** What a number is a quantity of. On/off values are states, and say nothing here. */
  quantity?: Quantity;
  /**
   * What it means: a standard meaning (`battery.soc`) — whose unit, quantity and
   * state class it must then keep — or one namespaced by the type
   * (`station.minutesToFull`).
   */
  means?: string;
  stateClass?: StateClass;
  /** `write` is a setting the device remembers and can be told. `read` when absent. */
  access?: AttributeAccess;
  category?: AttributeCategory;
  /** A heading to group it under, on generic screens: "Charging". */
  section?: string;
  /** Physical and consequential: a person confirms it, an automation never can. */
  dangerous?: boolean;
  /** What happens, in one line, shown before changing it. */
  consequence?: string;
  /** Kept in history. True when absent, except for settings. */
  history?: boolean;
};

export type EventLevel = 'info' | 'warn' | 'error';

/** Something that happens, rather than a value that is: an overload trip, a button press. */
export type EventSpec = {
  /** Unique in the device: `overload`, `button.pressed`. */
  id: string;
  label: string;
  level: EventLevel;
  part?: string;
  description?: string;
  /** What it carries, each a value of the one value system. */
  data?: Readonly<Record<string, ValueType>>;
};

export type DeviceDescription = {
  /** `main` is always there; declare it only to name it or give it a role. */
  parts?: readonly Part[];
  attributes: readonly AttributeSpec[];
  events?: readonly EventSpec[];
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

/** A value an attribute holds, and when the device produced it. */
export type AttributeReading = { key: string; value: Value; at: string };

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

/** What a value is a quantity of: declared, or the standard meaning's, or a state for on/off. */
export function quantityOf(attribute: Pick<AttributeSpec, 'quantity' | 'means' | 'value'>): Quantity | null {
  if (attribute.quantity) return attribute.quantity;
  if (attribute.means && attribute.means in STANDARD_METRICS) return STANDARD_METRICS[attribute.means as StandardMetricId].kind;
  return attribute.value.type === 'boolean' ? 'state' : null;
}

/** Whether history keeps it. */
export const keepsHistory = (attribute: Pick<AttributeSpec, 'history' | 'access' | 'value'>): boolean =>
  attribute.history ?? (attribute.access !== 'write' && attribute.value.type !== 'string');

/**
 * The capabilities a part offers: every read-only capability whose required
 * meanings its attributes carry, and every capability it names in `offers`.
 */
export function capabilitiesOf(description: DeviceDescription, part: string): CapabilityName[] {
  const meanings = new Set(attributesOf(description, part).flatMap((attribute) => (attribute.means ? [attribute.means] : [])));
  const offers = partsOf(description).find((candidate) => candidate.id === part)?.offers ?? [];
  const names = Object.keys(CAPABILITIES) as CapabilityName[];
  return names.filter((name) => {
    if (offers.includes(name)) return true;
    const spec = CAPABILITIES[name];
    const acts = Object.keys(spec.commands).length > 0 || Object.keys((spec as { queries?: object }).queries ?? {}).length > 0;
    const required = requiredMeanings(name);
    return !acts && required.length > 0 && required.every((meaning) => meanings.has(meaning));
  });
}

/** Every capability any part offers — what a role in an automation asks of a whole device. */
export const deviceCapabilities = (description: DeviceDescription): CapabilityName[] => [
  ...new Set(partsOf(description).flatMap((part) => capabilitiesOf(description, part.id))),
];

/** The attribute on a part that carries a meaning, if it has one. */
export const attributeMeaning = (description: DeviceDescription, part: string, means: string): AttributeSpec | null =>
  attributesOf(description, part).find((attribute) => attribute.means === means) ?? null;

/** Checks a value an attribute reports or is given against the attribute's type. */
export const checkAttributeValue = (attribute: AttributeSpec, value: unknown) => checkValue(attribute.value, value);

// --- checking a description --------------------------------------------------------

const PART_ID = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function valueTypeProblems(what: string, type: ValueType): string[] {
  switch (type.type) {
    case 'enum': {
      const values = type.options.map((option) => option.value);
      if (!values.length) return [`${what} is an enum with no options`];
      return new Set(values).size === values.length ? [] : [`${what} is an enum with an option twice`];
    }
    case 'number':
      return type.min !== undefined && type.max !== undefined && type.min > type.max ? [`${what} has a minimum above its maximum`] : [];
    case 'boolean':
    case 'string':
      return [];
    default:
      return [`${what} has an unknown value type "${(type as { type: string }).type}"`];
  }
}

/**
 * Every problem with a description, not just the first — the static half of
 * the device model's contract. `typeId` names the type's own namespace, for
 * the message about a meaning that is not standard.
 */
export function validateDescription(description: DeviceDescription, typeId = 'brand.model'): string[] {
  const problems: string[] = [];
  const problem = (message: string) => problems.push(message);

  // --- parts --------------------------------------------------------------------
  const parts = partsOf(description);
  const partIds = new Set<string>();
  for (const part of description.parts ?? []) {
    if (!PART_ID.test(part.id ?? '')) problem(`part id "${part.id}" must be lowercase words, dotted: "outlet.ac", "pack.1"`);
    if (partIds.has(part.id)) problem(`part "${part.id}" is declared twice`);
    partIds.add(part.id);
    if (!part.label?.trim() && part.id !== MAIN_PART) problem(`part "${part.id}" has no label`);
  }
  partIds.add(MAIN_PART);
  for (const part of parts) {
    if (part.parent !== undefined && !partIds.has(part.parent)) problem(`part "${part.id}" belongs to "${part.parent}", which is not a part`);
    for (const name of part.offers ?? []) {
      if (!isCapability(name)) {
        problem(`part "${part.id}" offers "${name}", which is not in the library`);
        continue;
      }
      for (const meaning of requiredMeanings(name)) {
        if (!attributeMeaning(description, part.id, meaning)) problem(`part "${part.id}" offers "${name}", which needs an attribute meaning "${meaning}"`);
      }
    }
  }

  // --- attributes ----------------------------------------------------------------
  const keys = new Set<string>();
  const primaries = new Map<string, number>();
  const meanings = new Set<string>();
  for (const attribute of description.attributes ?? []) {
    const where = `attribute "${attribute.key}"`;
    if (!KEY.test(attribute.key ?? '')) problem(`an attribute has no usable key ("${attribute.key}")`);
    if (keys.has(attribute.key)) problem(`${where} is declared twice`);
    keys.add(attribute.key);
    if (!partIds.has(partOf(attribute))) problem(`${where} belongs to "${partOf(attribute)}", which is not a part`);
    if (!attribute.label?.trim()) problem(`${where} has no label`);
    problems.push(...valueTypeProblems(where, attribute.value ?? ({} as ValueType)));
    if (attribute.category === 'primary') primaries.set(partOf(attribute), (primaries.get(partOf(attribute)) ?? 0) + 1);

    if (attribute.stateClass !== undefined) {
      if (!STATE_CLASSES.includes(attribute.stateClass)) problem(`${where} has an unknown state class "${attribute.stateClass}"`);
      else if (attribute.value?.type !== 'number') problem(`${where} has a state class, which only a number can have`);
    }
    if (attribute.quantity !== undefined && attribute.value?.type !== 'number') problem(`${where} names a quantity, which only a number has`);
    if (attribute.dangerous && attribute.access !== 'write') problem(`${where} is dangerous but cannot be written; a command's danger is its capability's`);
    if (attribute.category === 'config' && attribute.access !== 'write') problem(`${where} is a setting that cannot be written`);

    if (attribute.means === undefined) continue;
    const meaningInPart = `${partOf(attribute)}:${attribute.means}`;
    if (meanings.has(meaningInPart)) problem(`part "${partOf(attribute)}" has two attributes meaning "${attribute.means}"`);
    meanings.add(meaningInPart);

    if (attribute.means in STANDARD_METRICS) {
      const standard = STANDARD_METRICS[attribute.means as StandardMetricId];
      const standardState = 'stateClass' in standard ? standard.stateClass : 'measurement';
      if (standard.kind === 'state') {
        if (attribute.value?.type !== 'boolean') problem(`${where} means ${attribute.means}, which is on or off, but is not a boolean`);
      } else if (attribute.value?.type !== 'number' || (attribute.value.unit ?? '') !== standard.unit || quantityOf(attribute) !== standard.kind) {
        problem(`${where} means ${attribute.means}, which is ${standard.kind} in "${standard.unit}"`);
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
    if (event.part !== undefined && !partIds.has(event.part)) problem(`event "${event.id}" belongs to "${event.part}", which is not a part`);
    for (const [name, type] of Object.entries(event.data ?? {})) problems.push(...valueTypeProblems(`event "${event.id}" data "${name}"`, type));
  }

  return problems;
}
