/**
 * What a value means, in words every device shares (docs/ARCHITECTURE.md §4.2).
 *
 * An attribute has two names on purpose. Its **key** is what history is kept
 * under, local to its type — a station's `soc`, a plug's `watts`. Its
 * **meaning** is what it is, in words every device uses — `charge`,
 * `power` — and is what the generic screens, charts that compare devices,
 * automations and the bridges to Home Assistant and Matter work from. Keeping
 * them apart lets meaning be added to a type without touching what it stored.
 *
 * A standard meaning is one word, named by what is measured — `temperature`,
 * not the weather service's temperature — and the part it is on says where:
 * an outdoor thermometer, a BTHome sensor and a forecast all report the air's
 * temperature. The word is what a rule reads: `station.charge`,
 * `charger.power`. A type's own meanings are namespaced, `acme.minutesToFull`,
 * so the two never meet.
 */

import type { Quantity } from './quantities.ts';
import type { Unit } from './units.ts';

/**
 * How a value moves over time, which decides how history treats it — the same
 * three Home Assistant uses:
 *
 * - `measurement` — a value now: power, a temperature.
 * - `total` — a running amount that may go down or restart: today's energy.
 * - `total_increasing` — a counter that only rises, whose fall means the
 *   device restarted it: a meter's lifetime energy.
 */
export type StateClass = 'measurement' | 'total' | 'total_increasing';

export const STATE_CLASSES: readonly StateClass[] = ['measurement', 'total', 'total_increasing'];

/**
 * A standard meaning: a number, with the unit, quantity and state class every
 * attribute claiming it keeps; an on/off; or a value with structure, of its
 * quantity's shape — a position.
 */
export type StandardMeaning =
  | {
      label: string;
      type: 'number';
      /** The unit it is in — none for one that has none, a rank. */
      unit?: Unit;
      /** Other units an attribute claiming it may be in instead — a price is in its provider's currency — each one its quantity allows. */
      units?: readonly Unit[];
      quantity: Quantity;
      stateClass?: StateClass;
    }
  | { label: string; type: 'boolean' }
  | { label: string; type: 'object'; quantity: Quantity };

/** The units an attribute with this meaning may be in: its own, or one of the others it allows. */
export const unitsOfMeaning = (meaning: Extract<StandardMeaning, { type: 'number' }>): readonly Unit[] => [...(meaning.unit ? [meaning.unit] : []), ...(meaning.units ?? [])];

/**
 * Meanings every device that has them shares.
 *
 * Deliberately few, and added to only when something — a chart, an automation,
 * a capability, a bridge — needs to find a quantity on devices it knows nothing
 * about, and with the first device that has one, not before. An attribute that
 * claims one keeps its unit, quantity and state class, so two devices' values
 * share an axis without conversion.
 */
export const STANDARD_MEANINGS = {
  charge: { label: 'Charge', type: 'number', unit: '%', quantity: 'percent' },
  capacity: { label: 'Capacity', type: 'number', unit: 'Wh', quantity: 'energy' },
  /** A setting a station keeps: the charge it stops charging from mains at. */
  chargeLimit: { label: 'Charge limit', type: 'number', unit: '%', quantity: 'percent' },
  /** A setting a station keeps: the charge below which it stops supplying its outputs. */
  dischargeFloor: { label: 'Discharge floor', type: 'number', unit: '%', quantity: 'percent' },
  /** Everything coming in, from any source. */
  input: { label: 'Input', type: 'number', unit: 'W', quantity: 'power' },
  mainsInput: { label: 'From mains', type: 'number', unit: 'W', quantity: 'power' },
  solarInput: { label: 'Solar', type: 'number', unit: 'W', quantity: 'power' },
  /** A setting a station keeps: how hard it charges from mains, at most. */
  mainsInputLimit: { label: 'Mains charging power', type: 'number', unit: 'W', quantity: 'power' },
  /** Everything a device supplies to what is plugged into it. */
  output: { label: 'Output', type: 'number', unit: 'W', quantity: 'power' },
  /** What a device, or what is plugged through it, consumes: a plug's meter, an outlet's draw. */
  power: { label: 'Power', type: 'number', unit: 'W', quantity: 'power' },
  /** A meter's own lifetime counter. */
  energy: { label: 'Energy', type: 'number', unit: 'kWh', quantity: 'energy', stateClass: 'total_increasing' },
  voltage: { label: 'Voltage', type: 'number', unit: 'V', quantity: 'voltage' },
  current: { label: 'Current', type: 'number', unit: 'A', quantity: 'current' },
  frequency: { label: 'Frequency', type: 'number', unit: 'Hz', quantity: 'frequency' },
  mainsPresent: { label: 'Mains present', type: 'boolean' },
  on: { label: 'On', type: 'boolean' },
  /** The air's temperature, where the part is: outdoors, a room, the hour a forecast is for. */
  temperature: { label: 'Temperature', type: 'number', unit: '°C', quantity: 'temperature' },
  /** How much of the sky is cloud, measured or forecast. */
  cloudCover: { label: 'Cloud cover', type: 'number', unit: '%', quantity: 'percent' },
  /** What electricity costs now, per kWh, in the provider's currency. */
  price: { label: 'Electricity price', type: 'number', unit: 'EUR/kWh', units: ['SEK/kWh', 'NOK/kWh', 'DKK/kWh'], quantity: 'price' },
  /** Where the hour now stands among the day's hours by price: 1 is the cheapest. "The cheapest four hours" is a rank of 4 or less. */
  priceRank: { label: 'Price rank', type: 'number', quantity: 'rank' },
  /** Where it is on the Earth: a phone, a scooter, a tag — a latitude, a longitude and how sure (`POSITION_SHAPE`). */
  position: { label: 'Position', type: 'object', quantity: 'position' },
} as const satisfies Record<string, StandardMeaning>;

export type StandardMeaningId = keyof typeof STANDARD_MEANINGS;

/** The standard a meaning is, or null when it is a type's own. */
export const standardMeaning = (id: string): StandardMeaning | null =>
  Object.hasOwn(STANDARD_MEANINGS, id) ? STANDARD_MEANINGS[id as StandardMeaningId] : null;