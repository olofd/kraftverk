import { describe, expect, test } from 'bun:test';

import { validateDescription } from './check-description.ts';
import { QUANTITIES, STANDARD_MEANINGS, unitsOfMeaning } from './meanings.ts';
import { convert, convertible, isUnit, QUANTITY_UNITS, UNIT_LIST, UNITS, unitsLike, wholeTime } from './units.ts';
import { valueTypeProblems } from './values.ts';

/*
  The units kraftverk knows: one enumeration, never free text. What a device
  declares, what a meaning keeps and what a rule writes beside a number are
  each one of them, and a number meets another of its dimension converted —
  never one of another.
*/

describe('the units', () => {
  test('are one list, each with words, what it measures and how it converts', () => {
    expect(UNIT_LIST.length).toBe(new Set(UNIT_LIST).size);
    for (const unit of UNIT_LIST) {
      expect(UNITS[unit].label.trim()).not.toBe('');
      expect(UNITS[unit].factor).toBeGreaterThan(0);
    }
  });

  test('a unit is known, or it is not: text from outside is held to the list', () => {
    expect(['W', 'kWh', '%', '°C', 'min', 'SEK/kWh'].every(isUnit)).toBe(true);
    expect(['', 'w', 'watt', 'parsecs', 'kw', 42, null].some(isUnit)).toBe(false);
  });

  test('converts within what it measures, and never across', () => {
    expect(convert(2.2, 'kW', 'W')).toBe(2200);
    expect(convert(90, 'min', 'h')).toBe(1.5);
    expect(convert(212, '°F', '°C')).toBe(100);
    expect(convert(0, '°C', 'K')).toBe(273.15);
    expect(convert(36, 'km/h', 'm/s')).toBe(10);
    expect(convert(50, '°C', 'W')).toBeNull();
    // A price is in its provider's currency: no rate between currencies is kraftverk's to know.
    expect(convertible('SEK/kWh', 'EUR/kWh')).toBe(false);
    expect(unitsLike('kW')).toEqual(['kW', 'W', 'MW']);
  });

  test('every quantity is measured in units that measure one thing, and every standard meaning in its quantity’s', () => {
    for (const quantity of QUANTITIES) {
      const units = QUANTITY_UNITS[quantity];
      // Prices are each in a currency of their own; anything else converts within its quantity.
      if (quantity !== 'price') expect({ quantity, one: new Set(units.map((unit) => UNITS[unit].dimension)).size <= 1 }).toEqual({ quantity, one: true });
    }
    for (const [id, meaning] of Object.entries(STANDARD_MEANINGS)) {
      if (meaning.type !== 'number') continue;
      expect({ id, ok: unitsOfMeaning(meaning).every((unit) => QUANTITY_UNITS[meaning.quantity].includes(unit)) }).toEqual({ id, ok: true });
    }
  });

  test('a length of time in the largest unit that says it whole', () => {
    expect([90, 120, 7_200, 86_400, 0].map(wholeTime)).toEqual([
      { value: 90, unit: 's' },
      { value: 2, unit: 'min' },
      { value: 2, unit: 'h' },
      { value: 1, unit: 'd' },
      { value: 0, unit: 's' },
    ]);
  });
});

describe('a description', () => {
  const described = (unit: unknown, quantity?: string) =>
    validateDescription({
      parts: [{ id: 'main', label: 'Meter', kind: 'device' }],
      attributes: [{ key: 'watts', label: 'Power', value: { type: 'number', unit } as never, ...(quantity ? { quantity: quantity as never } : {}) }],
    });

  test('names only units kraftverk knows — one arriving as data is refused, not taken as it is', () => {
    expect(described('W', 'power')).toEqual([]);
    expect(described('watts')).toContain('attribute "watts" is in "watts", which is not a unit kraftverk knows');
    expect(valueTypeProblems('x', { type: 'number', unit: 'parsecs' as never })).toEqual(['x is in "parsecs", which is not a unit kraftverk knows']);
  });

  test('a number of a quantity is in one of the units it is measured in', () => {
    expect(described('°C', 'power')).toContain('attribute "watts" is power, which is not measured in "°C": "W", "kW", "MW"');
  });
});
