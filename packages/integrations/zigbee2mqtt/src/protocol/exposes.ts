import {
  isUnit,
  MAIN_PART,
  partOf,
  standardMeaning,
  type AttributeSpec,
  type DeviceDescription,
  type EnumOption,
  type EventSpec,
  type Part,
  type PartKind,
  type Quantity,
  type ScalarValueType,
  type Unit,
  type Value,
  type ValueType,
} from '@kraftverk/device-sdk';

import { firmwareEvents, firmwareFields } from './firmware.ts';
import { ACCESS, objectOf, type Expose } from './wire.ts';

/*
  What a Zigbee device is, from what Zigbee2MQTT says it exposes
  (docs/PLAN-ZIGBEE.md §5.1): its parts, its attributes with their meanings,
  its events — and, for each attribute, where its value is in what the device
  publishes and how a value is written back. Pure: the same mapping whoever
  drives the radio. What Zigbee2MQTT's own Home Assistant mapping taught is
  kept (§5.6): a binary is read by its `value_on`, never by its name; a
  battery's voltage is not the mains'; a standard meaning only where the unit
  is the meaning's own.
*/

/** One attribute, and where it lives in the device's state. */
export type Field = {
  spec: AttributeSpec;
  /** Its property in the state Zigbee2MQTT publishes, and takes in `/set`: `state_l1`, `brightness`. */
  property: string;
  /** What a raw value is, in kraftverk's value system: null when it is not one this field can be. */
  read(raw: unknown): Value;
  /** The raw value a kraftverk value is written as; undefined when it cannot be. */
  write(value: Value): unknown;
  settable: boolean;
  gettable: boolean;
};

/** The shelf a device lands on: which generic type it is offered as (§5.3). */
export type Shelf = 'plug' | 'switch' | 'light' | 'sensor' | 'climate' | 'lock' | 'cover';

export const SHELVES: readonly Shelf[] = ['plug', 'switch', 'light', 'sensor', 'climate', 'lock', 'cover'];

/** A device, as its exposes make it. */
export type Shape = {
  description: DeviceDescription;
  fields: readonly Field[];
  /** The fields that switch a part, by the part: what `switch.set` writes. */
  switches: ReadonlyMap<string, Field>;
  /** Its button presses: the property they arrive on, and each value's event. */
  action: { property: string; events: ReadonlyMap<string, string> } | null;
  shelf: Shelf;
  /** The properties of its own settings, written or not: what a firmware update is checked not to have changed (docs/PLAN-ZIGBEE.md §5.7). */
  settings: readonly { property: string; gettable: boolean }[];
};

/** A part id from an endpoint's name: `l1`, `left`, `1`. */
const endpointId = (endpoint: string): string => endpoint.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'ep';

/** An attribute key's own part: a property as kraftverk keys it — `local_temperature` stays itself. */
const keyName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[^A-Za-z0-9]+/, '') || 'value';

/** "local_temperature" → "Local temperature": a label where Zigbee2MQTT gives none. */
const labelOf = (expose: Expose): string => {
  const raw = expose.label ?? expose.name ?? expose.property ?? 'Value';
  const words = raw.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const can = (expose: Expose, bit: number): boolean => ((expose.access ?? ACCESS.STATE) & bit) !== 0;

/** Standard meanings by the expose's name, taken only in the meaning's own unit and never on a diagnostic (§5.6). */
const MEANING_BY_NAME: Readonly<Record<string, string>> = {
  power: 'power',
  voltage: 'voltage',
  current: 'current',
  energy: 'energy',
  temperature: 'temperature',
  local_temperature: 'temperature',
  frequency: 'frequency',
  ac_frequency: 'frequency',
  // What says someone is there: a motion sensor's occupancy is motion, a radar's presence someone there, a contact open.
  occupancy: 'motion',
  presence: 'occupied',
  contact: 'open',
};

/** Quantities by the expose's name, for what has no standard meaning of its own. */
const QUANTITY_BY_NAME: Readonly<Record<string, Quantity>> = {
  humidity: 'humidity',
  illuminance: 'illuminance',
  illuminance_lux: 'illuminance',
  battery: 'percent',
  device_temperature: 'temperature',
  soil_moisture: 'humidity',
};

/** What is diagnostic whatever Zigbee2MQTT says: how the radio is doing, and the device itself rather than what it measures. */
const DIAGNOSTIC = new Set(['linkquality', 'battery', 'battery_low', 'voltage_battery', 'device_temperature', 'power_outage_count', 'update']);

/** Unit text Zigbee2MQTT uses that kraftverk knows by another name. */
const UNIT_ALIASES: Readonly<Record<string, Unit>> = { C: '°C', '°': '°', lux: 'lx', sec: 's', seconds: 's', minutes: 'min', hours: 'h' };

const unitOf = (text: string | undefined): Unit | null => {
  if (!text) return null;
  const unit = UNIT_ALIASES[text] ?? text;
  return isUnit(unit) ? unit : null;
};

/** Where a part's attributes say where they are. */
type Where = { part: string; prefix: string };

const where = (part: string): Where => ({ part, prefix: part === MAIN_PART ? '' : `${part}.` });

/** A light's brightness as a percentage, as people read it — Zigbee's 0–254 underneath. */
const BRIGHTNESS_MAX = 254;

/** The value type of a generic expose, or null for one kraftverk does not keep. */
function valueOf(expose: Expose): ValueType | null {
  switch (expose.type) {
    case 'binary':
      return { type: 'boolean' };
    case 'numeric': {
      const unit = unitOf(expose.unit);
      return {
        type: 'number',
        ...(unit ? { unit } : {}),
        ...(typeof expose.value_min === 'number' ? { min: expose.value_min } : {}),
        ...(typeof expose.value_max === 'number' ? { max: expose.value_max } : {}),
      };
    }
    case 'enum': {
      // A value in capitals — a cover's OPEN — is said as a word: Open.
      const said = (value: string) => labelOf({ type: 'enum', name: value === value.toUpperCase() ? value.toLowerCase() : value });
      const options: EnumOption[] = (expose.values ?? []).filter((value): value is string | number => typeof value === 'string' || typeof value === 'number').map((value) => ({ value: String(value), label: said(String(value)) }));
      return options.length ? { type: 'enum', options } : { type: 'string' };
    }
    case 'text':
      return { type: 'string' };
    case 'composite': {
      const fields: Record<string, ValueType> = {};
      for (const feature of expose.features ?? []) {
        const name = feature.property ?? feature.name;
        const value = name ? valueOf(feature) : null;
        if (name && value) fields[name] = value;
      }
      return Object.keys(fields).length ? { type: 'object', fields } : null;
    }
    case 'list': {
      const item = expose.item_type ? valueOf(expose.item_type) : null;
      return item ? { type: 'list', of: item } : null;
    }
    default:
      return null;
  }
}

/** Reads a raw value as a value of `type`; null when it is not one. Numbers stay numbers, enums their text. */
function readAs(type: ValueType, raw: unknown, expose: Expose): Value {
  if (raw === undefined || raw === null) return null;
  switch (type.type) {
    case 'boolean':
      // By its own on and off — a contact's `on` is false (§5.6) — and plain booleans where it says neither.
      if ('value_on' in expose || 'value_off' in expose) return raw === expose.value_on ? true : raw === expose.value_off ? false : null;
      return typeof raw === 'boolean' ? raw : null;
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    case 'enum':
      // One of its values, or not known: a value it does not list is not one.
      return (typeof raw === 'string' || typeof raw === 'number') && type.options.some((option) => option.value === String(raw)) ? String(raw) : null;
    case 'string':
      return typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : null;
    case 'object': {
      const object = objectOf(raw);
      if (!object) return null;
      const out: Record<string, Value> = {};
      for (const feature of expose.features ?? []) {
        const name = feature.property ?? feature.name;
        const fieldType = name ? type.fields[name] : undefined;
        if (name && fieldType) out[name] = readAs(fieldType, object[name], feature);
      }
      return out;
    }
    case 'list':
      return Array.isArray(raw) ? raw.map((item) => readAs(type.of, item, expose.item_type ?? { type: 'text' })) : null;
    default:
      return null;
  }
}

/** Writes a value back as Zigbee2MQTT takes it; undefined when it cannot be. */
function writeAs(type: ValueType, value: Value, expose: Expose): unknown {
  if (value === null) return undefined;
  switch (type.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return undefined;
      if ('value_on' in expose || 'value_off' in expose) return value ? expose.value_on : expose.value_off;
      return value;
    case 'number':
      return typeof value === 'number' ? value : undefined;
    case 'enum': {
      if (typeof value !== 'string') return undefined;
      // Back as the device has it: a number where its values are numbers.
      const original = (expose.values ?? []).find((candidate) => String(candidate) === value);
      return original ?? undefined;
    }
    case 'string':
      return typeof value === 'string' ? value : undefined;
    case 'object':
    case 'list':
      return value;
    default:
      return undefined;
  }
}

/** The property an expose lives at, endpoint and all: `state_l1`. */
const propertyOf = (expose: Expose): string | null => expose.property ?? expose.name ?? null;

/** What a specific expose becomes: the part's kind, what it is called, and which of its features switches it. */
const SPECIFIC: Readonly<Record<string, { kind: PartKind; label: string; switches: boolean }>> = {
  switch: { kind: 'outlet', label: 'Output', switches: true },
  light: { kind: 'light', label: 'Light', switches: true },
  fan: { kind: 'fan', label: 'Fan', switches: true },
  cover: { kind: 'cover', label: 'Cover', switches: false },
  lock: { kind: 'lock', label: 'Lock', switches: false },
  climate: { kind: 'other', label: 'Thermostat', switches: false },
};

/** Kept beside its device's attributes: the part's own label, when it has an endpoint. */
const partLabel = (base: string, endpoint: string | undefined): string => (endpoint ? `${base} ${endpoint.toUpperCase()}` : base);

/**
 * A device's shape from its exposes: one part per switch, light, fan, cover,
 * lock or thermostat (per endpoint), its features its attributes; every
 * other expose an attribute of `main` — or, for a meter on a device with one
 * switching part, of that part, so a plug's power is its outlet's.
 */
export function shapeOf(exposes: readonly Expose[], options: { /** Zigbee2MQTT can update its firmware (`definition.supports_ota`). */ ota?: boolean } = {}): Shape {
  const parts: Part[] = [{ id: MAIN_PART, label: 'Device', kind: 'device' }];
  const fields: Field[] = [];
  const switches = new Map<string, Field>();
  const events: EventSpec[] = [];
  let action: Shape['action'] = null;
  const keys = new Set<string>();
  const kinds = new Set<string>();

  const uniqueKey = (wanted: string): string => {
    let key = wanted;
    for (let n = 2; keys.has(key); n++) key = `${wanted}_${n}`;
    keys.add(key);
    return key;
  };

  const specifics = exposes.filter((expose) => expose.type in SPECIFIC);
  const switching = specifics.filter((expose) => SPECIFIC[expose.type]!.switches);
  const partIds = new Set<string>();

  /** One generic expose as an attribute of a part. */
  const add = (expose: Expose, at: Where, options: { switchOf?: string; kindOf?: string } = {}) => {
    const property = propertyOf(expose);
    if (!property) return;
    const name = expose.name ?? property;
    const settable = can(expose, ACCESS.SET);
    const published = can(expose, ACCESS.STATE);
    if (!published && !settable) return;

    // The switching state of a part: its `on`, switched by the capability, not written.
    if (options.switchOf && name === 'state' && expose.type === 'binary') {
      const spec: AttributeSpec = {
        key: uniqueKey(`${at.prefix}on`),
        part: at.part,
        label: options.kindOf === 'light' ? 'On' : 'Switch',
        value: { type: 'boolean' },
        means: 'on',
        ...(options.kindOf === 'light' ? {} : { consequence: 'Switches off whatever it feeds.' }),
      };
      const field: Field = { spec, property, read: (raw) => readAs(spec.value, raw, expose), write: (value) => writeAs(spec.value, value, expose), settable, gettable: can(expose, ACCESS.GET) };
      fields.push(field);
      if (settable) switches.set(at.part, field);
      return;
    }

    // A light's brightness, as a percentage.
    if (options.kindOf === 'light' && name === 'brightness' && expose.type === 'numeric') {
      const spec: AttributeSpec = { key: uniqueKey(`${at.prefix}brightness`), part: at.part, label: 'Brightness', value: { type: 'number', unit: '%', min: 0, max: 100 }, quantity: 'percent', ...(settable ? { access: 'write' as const } : {}) };
      const max = typeof expose.value_max === 'number' ? expose.value_max : BRIGHTNESS_MAX;
      fields.push({
        spec,
        property,
        read: (raw) => (typeof raw === 'number' ? Math.round((raw / max) * 100) : null),
        write: (value) => (typeof value === 'number' ? Math.round((Math.min(100, Math.max(0, value)) / 100) * max) : undefined),
        settable,
        gettable: can(expose, ACCESS.GET),
      });
      return;
    }

    const value = valueOf(expose);
    if (!value) return;
    // A setting is one value: a structured one — a light's colour — is read, and set by a capability of its own when there is one.
    const writable = settable && value.type !== 'object' && value.type !== 'list';
    /*
      A device's own structured setting — a plug's overload protection, its
      inching — is a setting, not a reading, and one kraftverk cannot write
      yet: left out, rather than shown as a value nobody can read, until
      structured settings are written (docs/PLAN-ZIGBEE.md §5.5).
    */
    if (settable && !writable && !options.kindOf) return;
    const diagnostic = DIAGNOSTIC.has(name) || expose.category === 'diagnostic' || (value.type === 'number' && value.unit === 'mV');
    const unit = value.type === 'number' ? (value.unit ?? null) : null;
    const meaning = MEANING_BY_NAME[name];
    const standard = meaning ? standardMeaning(meaning) : null;
    const meansIt = Boolean(
      standard && !diagnostic && !writable && ((standard.type === 'number' && 'unit' in standard && standard.unit === unit) || (standard.type === 'boolean' && value.type === 'boolean'))
    );
    const quantity = !meansIt ? QUANTITY_BY_NAME[name] : undefined;
    const spec: AttributeSpec = {
      // A composite by its property — a light's `color` — which is what its state says it under.
      key: uniqueKey(`${at.prefix}${keyName(expose.type === 'composite' ? property : name)}`),
      part: at.part,
      // A contact's `on` is open (§5.6), a lock's locked: said so.
      label: name === 'contact' ? 'Open' : options.kindOf === 'lock' && name === 'state' ? 'Locked' : name === 'linkquality' ? 'Link quality' : labelOf(expose) + (expose.unit && !unit ? ` (${expose.unit})` : ''),
      ...(expose.description ? { description: expose.description } : {}),
      value,
      ...(meansIt ? { means: meaning } : {}),
      ...(quantity && value.type === 'number' && (!unit || quantityFits(quantity, unit)) ? { quantity } : {}),
      ...(meansIt && meaning === 'energy' ? { stateClass: 'total_increasing' as const } : {}),
      ...(writable ? { access: 'write' as const } : {}),
      ...(diagnostic && !writable ? { category: 'diagnostic' as const } : writable && expose.category === 'config' ? { category: 'config' as const } : {}),
      ...(!published ? { history: false } : {}),
      ...(options.kindOf === 'lock' && name === 'state' && writable ? { dangerous: true } : {}),
      ...(/setpoint/.test(name) && writable ? { dangerous: true } : {}),
    };
    fields.push({ spec, property, read: (raw) => readAs(value, raw, expose), write: (v) => writeAs(value, v, expose), settable: writable, gettable: can(expose, ACCESS.GET) });
  };

  /*
    One switch, light, lock or cover, on no endpoint of its own, is the device
    itself: a plug is its socket, as every other plug in kraftverk is — its
    `on` and its power the device's, leading its card. Several, or one on a
    named endpoint, are each a part of their own.
  */
  const alone = specifics.length === 1 && !specifics[0]!.endpoint ? specifics[0]! : null;

  for (const expose of specifics) {
    const shape = SPECIFIC[expose.type]!;
    kinds.add(expose.type);
    const base = expose.type === 'switch' ? 'switch' : expose.type;
    let id = expose === alone ? MAIN_PART : expose.endpoint ? `${base}.${endpointId(expose.endpoint)}` : base;
    for (let n = 2; partIds.has(id); n++) id = `${base}.${n}`;
    partIds.add(id);
    const offersSwitch = shape.switches && (expose.features ?? []).some((feature) => feature.name === 'state' && can(feature, ACCESS.SET));
    const part: Part = {
      id,
      label: partLabel(shape.label, expose.endpoint),
      kind: shape.kind,
      ...(expose.type === 'switch' || expose.type === 'light' ? { energy: { role: 'load' as const } } : {}),
      ...(offersSwitch ? { offers: ['switch' as const] } : {}),
    };
    if (id === MAIN_PART) parts[0] = part;
    else parts.push(part);
    for (const feature of expose.features ?? []) {
      // A light's colour is one value of its own shape, not its parts.
      if (feature.type === 'composite' || !feature.features) add(feature, where(id), { switchOf: shape.switches ? id : undefined, kindOf: expose.type });
    }
  }

  // A meter beside one switching part is that part's: a plug's power is its outlet's.
  const meterPart = switching.length === 1 ? parts.find((part) => part.id !== MAIN_PART && part.kind !== 'light')?.id ?? null : null;
  const METER = new Set(['power', 'voltage', 'current', 'energy', 'frequency', 'ac_frequency', 'power_factor']);

  const settings: { property: string; gettable: boolean }[] = [];
  for (const expose of exposes) {
    if (expose.type in SPECIFIC) continue;
    const name = expose.name ?? expose.property ?? '';
    if (expose.property && can(expose, ACCESS.SET) && can(expose, ACCESS.STATE)) settings.push({ property: expose.property, gettable: can(expose, ACCESS.GET) });
    if (name === 'action' && expose.type === 'enum') {
      const map = new Map<string, string>();
      for (const value of expose.values ?? []) {
        const text = String(value);
        // A value with a wildcard (`recall_*`) is not one press: the generic event carries it.
        if (text.includes('*')) continue;
        const id = `action.${keyName(text)}`;
        if (map.has(text) || events.some((event) => event.id === id)) continue;
        map.set(text, id);
        events.push({ id, label: labelOf({ type: 'enum', name: text }), level: 'info', data: { action: { type: 'string' } satisfies ScalarValueType } });
      }
      events.push({ id: 'action', label: 'Pressed', level: 'info', data: { action: { type: 'string' } } });
      action = { property: expose.property ?? 'action', events: map };
      continue;
    }
    // On the matching endpoint's part when there is one; a meter on the one switching part; else the device.
    const byEndpoint = expose.endpoint ? parts.find((part) => part.id.endsWith(`.${endpointId(expose.endpoint!)}`))?.id : undefined;
    const part = byEndpoint ?? (meterPart && METER.has(name) && !(expose.unit === 'mV') ? meterPart : MAIN_PART);
    add(expose, where(part));
  }

  // One meaning once on a part — two temperatures on endpoints with no part of their own: the first means it, the next is only itself.
  const meant = new Set<string>();
  for (const field of fields) {
    if (!field.spec.means) continue;
    const at = `${partOf(field.spec)}|${field.spec.means}`;
    if (meant.has(at)) delete (field.spec as { means?: string }).means;
    else meant.add(at);
  }

  // A plug's power leads its outlet's card; a sensor's temperature, the device's.
  const lead =
    fields.find((field) => field.spec.means === 'power') ??
    fields.find((field) => field.spec.means === 'temperature' || (field.spec.quantity === 'temperature' && field.spec.category !== 'diagnostic')) ??
    // A motion sensor's motion, a radar's someone there, a contact's open.
    fields.find((field) => field.spec.means === 'motion' || field.spec.means === 'occupied' || field.spec.means === 'open');
  if (lead) (lead.spec as { category?: string }).category = 'primary';

  const hasPower = fields.some((field) => field.spec.means === 'power');
  const shelf: Shelf = kinds.has('light')
    ? 'light'
    : kinds.has('lock')
      ? 'lock'
      : kinds.has('cover')
        ? 'cover'
        : kinds.has('climate')
          ? 'climate'
          : kinds.has('switch') || kinds.has('fan')
            ? hasPower
              ? 'plug'
              : 'switch'
            : 'sensor';

  // Its firmware, where Zigbee2MQTT can update it: diagnostics, and what an update did as events.
  if (options.ota) {
    fields.push(...firmwareFields());
    events.push(...firmwareEvents());
  }

  return {
    description: { parts, attributes: fields.map((field) => field.spec), ...(events.length ? { events } : {}) },
    fields,
    switches,
    action,
    shelf,
    settings,
  };
}

/** Whether a unit is one a quantity is measured in: a number of humidity is in %, never in mV. */
function quantityFits(quantity: Quantity, unit: Unit): boolean {
  const units: Readonly<Record<string, readonly Unit[]>> = { humidity: ['%'], illuminance: ['lx'], percent: ['%'], temperature: ['°C', '°F', 'K'] };
  return (units[quantity] ?? []).includes(unit);
}

/** Every value a state message holds, as readings of the shape's attributes, stamped `at`. What it did not say is left out: unknown, not null. */
export function readingsOf(shape: Pick<Shape, 'fields'>, state: Readonly<Record<string, unknown>>, at: string): { key: string; value: Value; at: string }[] {
  return shape.fields.flatMap((field) => (field.property in state ? [{ key: field.spec.key, value: field.read(state[field.property]), at }] : []));
}

/** A press a state message carries, as the event it is, with what was said beside it (`action_*`); null for none. */
export function actionOf(shape: Pick<Shape, 'action'>, state: Readonly<Record<string, unknown>>): { id: string; data: Record<string, Value> } | null {
  if (!shape.action) return null;
  const raw = state[shape.action.property];
  if (typeof raw !== 'string' || raw === '') return null;
  const data: Record<string, Value> = { action: raw };
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith('action_') && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) data[key] = value;
  }
  return { id: shape.action.events.get(raw) ?? 'action', data };
}

/** The `/set` payload that writes these values, or why it cannot. */
export function setPayload(shape: Pick<Shape, 'fields'>, patch: Readonly<Record<string, Value>>): { payload: Record<string, unknown> } | { error: string } {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const field = shape.fields.find((candidate) => candidate.spec.key === key);
    if (!field) return { error: `It has no "${key}"` };
    if (!field.settable) return { error: `${field.spec.label} cannot be set` };
    const raw = field.write(value);
    if (raw === undefined) return { error: `${field.spec.label} cannot be ${JSON.stringify(value)}` };
    payload[field.property] = raw;
  }
  return { payload };
}

/** The `/get` payload that asks for every value that can be asked for, or null when none can. */
export function getPayload(shape: Pick<Shape, 'fields'>): Record<string, string> | null {
  const asked = shape.fields.filter((field) => field.gettable).map((field) => field.property);
  return asked.length ? Object.fromEntries(asked.map((property) => [property, ''])) : null;
}

/**
 * What a group can do, from its members' exposes, as Zigbee2MQTT works it
 * out (§5.6): a light, switch, lock or cover feature any member has — the
 * union — with a colour temperature's range the one all share. Endpoints
 * fall away: a group is switched as one.
 */
export function groupExposes(members: readonly (readonly Expose[])[]): Expose[] {
  const kinds = ['light', 'switch', 'lock', 'cover'] as const;
  const merged: Expose[] = [];
  for (const kind of kinds) {
    const features = new Map<string, Expose>();
    let any = false;
    for (const exposes of members) {
      for (const expose of exposes.filter((candidate) => candidate.type === kind)) {
        any = true;
        for (const feature of expose.features ?? []) {
          const name = feature.name ?? feature.property;
          if (!name) continue;
          const plain: Expose = { ...feature, property: name, endpoint: undefined };
          const had = features.get(name);
          if (!had) features.set(name, plain);
          else if (name === 'color_temp') {
            features.set(name, {
              ...had,
              value_min: Math.max(had.value_min ?? -Infinity, plain.value_min ?? -Infinity),
              value_max: Math.min(had.value_max ?? Infinity, plain.value_max ?? Infinity),
            });
          }
        }
      }
    }
    // One of each kind: the group is switched as one.
    if (any) merged.push({ type: kind, features: [...features.values()] });
  }
  return merged;
}
