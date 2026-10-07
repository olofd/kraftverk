import { describe, expect, test } from 'bun:test';

import { capabilitySpec, requiredMeanings } from './capabilities.ts';
import { validateDescription } from './check-description.ts';
import { capabilitiesOf, MAIN_PART, quantityOf, type DeviceDescription } from './description.ts';
import { isPosition, POSITION_SHAPE, QUANTITIES, quantitySpec, unitsOfQuantity } from './quantities.ts';
import { homeAssistantEntityOf } from './standards.ts';

/*
  Quantities as records (docs/PLAN-INTEGRATIONS.md §4.5): each one row — what
  a value of it is, its decimals, its axis, its Home Assistant class — and
  position the first with structure: where something is, one shape every
  device shares.
*/

/** A phone that reports only where it is: offering `location` by the meaning it carries. */
const phone = (position: DeviceDescription['attributes'][number]): DeviceDescription => ({ attributes: [position] });

describe('every quantity is a row', () => {
  test('a number in its units, or a value of its own shape — and an axis only for a number', () => {
    for (const quantity of QUANTITIES) {
      const spec = quantitySpec(quantity);
      expect({ quantity, axis: spec.value.type === 'number' ? spec.axis !== null : spec.axis === null }).toEqual({ quantity, axis: true });
    }
    expect(unitsOfQuantity('distance')).toContain('km');
    expect(unitsOfQuantity('position')).toEqual([]);
  });
});

describe('a position', () => {
  const attribute = { key: 'position', label: 'Where it is', value: POSITION_SHAPE, means: 'position' } as const;

  test('is a latitude and a longitude on the globe, and how sure, when it says', () => {
    expect(isPosition({ latitude: 59.3, longitude: 18.1 })).toBe(true);
    expect(isPosition({ latitude: 59.3, longitude: 18.1, accuracy: 25 })).toBe(true);
    expect(isPosition({ latitude: 91, longitude: 18.1 })).toBe(false);
    expect(isPosition({ latitude: '59.3', longitude: 18.1 })).toBe(false);
    expect(isPosition([59.3, 18.1])).toBe(false);
  });

  test('is what the location capability reports, of the shape its quantity says', () => {
    expect(requiredMeanings(capabilitySpec('location'))).toEqual(['position']);
    expect(quantityOf(attribute)).toBe('position');
    expect(validateDescription(phone(attribute), 'acme.phone')).toEqual([]);
    expect(capabilitiesOf(phone(attribute), MAIN_PART)).toEqual(['location']);
  });

  test('of any other shape is refused, said', () => {
    const flat = { ...attribute, value: { type: 'object', fields: { lat: { type: 'number' }, lon: { type: 'number' } } } } as const;
    expect(validateDescription(phone(flat), 'acme.phone').join()).toContain('means position, and a position is a value of its own shape: latitude, longitude, accuracy');
    const number = { ...attribute, value: { type: 'number', unit: 'm' } } as const;
    expect(validateDescription(phone(number), 'acme.phone').join()).toContain('means position');
  });

  test('is a device tracker in Home Assistant', () => {
    expect(homeAssistantEntityOf(attribute)).toEqual({ platform: 'device_tracker', deviceClass: null, stateClass: null, unit: null });
  });
});
