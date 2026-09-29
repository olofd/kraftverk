import { describe, expect, test } from 'bun:test';

import { CAPABILITIES, CAPABILITY_NAMES, type CapabilityAttribute } from './capabilities.ts';
import {
  CAPABILITY_PROJECTIONS,
  HOME_ASSISTANT_QUANTITIES,
  MATTER_CLUSTERS,
  MEANING_PROJECTIONS,
  homeAssistantEntityOf,
  isProjected,
} from './standards.ts';
import { STANDARD_MEANINGS, type StandardMeaning, type StandardMeaningId } from './meanings.ts';

/*
  The projections into Home Assistant and Matter (docs/ARCHITECTURE.md §8
  step 23). The maps are typed over the whole vocabulary, so a meaning or a
  capability without a projection does not compile; these check that what is
  projected is consistent — units Home Assistant accepts, clusters that exist,
  commands that are the capability's own.
*/

const meanings = Object.keys(STANDARD_MEANINGS) as StandardMeaningId[];

describe('standard meanings', () => {
  test("each number's unit is one Home Assistant accepts for its quantity", () => {
    for (const id of meanings) {
      const meaning: StandardMeaning = STANDARD_MEANINGS[id];
      if (meaning.type !== 'number') continue;
      expect({ id, ok: HOME_ASSISTANT_QUANTITIES[meaning.quantity].units.includes(meaning.unit) }).toEqual({ id, ok: true });
    }
  });

  test('an on/off is a binary sensor or a switch, and a number is a sensor', () => {
    for (const id of meanings) {
      const platform = MEANING_PROJECTIONS[id].homeAssistant.platform;
      const onOff = STANDARD_MEANINGS[id].type === 'boolean';
      expect({ id, platform: onOff ? platform !== 'sensor' : platform === 'sensor' }).toEqual({ id, platform: true });
    }
  });

  test('a Matter projection names a known cluster and a positive scale, or says why there is none', () => {
    for (const id of meanings) {
      const matter = MEANING_PROJECTIONS[id].matter;
      if (isProjected(matter)) {
        expect(MATTER_CLUSTERS[matter.cluster]).toBeGreaterThan(0);
        expect(matter.scale).toBeGreaterThan(0);
      } else {
        expect(matter.none.length).toBeGreaterThan(10);
      }
    }
  });
});

describe('capabilities', () => {
  test('every attribute is a standard meaning, so it projects', () => {
    for (const name of CAPABILITY_NAMES) {
      for (const [attribute, spec] of Object.entries(CAPABILITIES[name].attributes as Record<string, CapabilityAttribute>)) {
        expect({ name, attribute, known: spec.means in MEANING_PROJECTIONS }).toEqual({ name, attribute, known: true });
      }
    }
  });

  test('a command sets only attributes of its own capability, from arguments it has', () => {
    for (const name of CAPABILITY_NAMES) {
      const spec = CAPABILITIES[name];
      for (const [command, declared] of Object.entries(spec.commands as Record<string, { args: object; sets: Record<string, string> }>)) {
        for (const [argument, attribute] of Object.entries(declared.sets ?? {})) {
          expect({ name, command, argument, has: argument in declared.args }).toEqual({ name, command, argument, has: true });
          expect({ name, command, attribute, has: attribute in spec.attributes }).toEqual({ name, command, attribute, has: true });
        }
      }
    }
  });

  test('where a capability projects, each of its commands is named there', () => {
    for (const name of CAPABILITY_NAMES) {
      const projection = CAPABILITY_PROJECTIONS[name];
      for (const side of [projection.homeAssistant, projection.matter]) {
        if (!isProjected(side)) continue;
        expect({ name, commands: Object.keys(side.commands).sort() }).toEqual({ name, commands: Object.keys(CAPABILITIES[name].commands).sort() });
      }
    }
  });
});

describe('an attribute as Home Assistant should show it', () => {
  test("a plug's lifetime energy is a total_increasing energy sensor in kWh", () => {
    expect(homeAssistantEntityOf({ value: { type: 'number', unit: 'kWh' }, means: 'energy.total', stateClass: 'total_increasing' })).toEqual({
      platform: 'sensor',
      deviceClass: 'energy',
      stateClass: 'total_increasing',
      unit: 'kWh',
    });
  });

  test("a station's charge is a battery sensor, more specific than its quantity", () => {
    expect(homeAssistantEntityOf({ value: { type: 'number', unit: '%' }, means: 'battery.soc' }).deviceClass).toBe('battery');
  });

  test("a type's own attribute projects from its quantity alone", () => {
    expect(homeAssistantEntityOf({ value: { type: 'number', unit: 'min' }, quantity: 'duration', means: 'station.minutesToFull' })).toEqual({
      platform: 'sensor',
      deviceClass: 'duration',
      stateClass: 'measurement',
      unit: 'min',
    });
  });

  test('an on/off state is a binary sensor with no state class or unit', () => {
    expect(homeAssistantEntityOf({ value: { type: 'boolean' } })).toEqual({ platform: 'binary_sensor', deviceClass: null, stateClass: null, unit: null });
  });

  test('an operating mode is a sensor with no class, unit or state class', () => {
    expect(homeAssistantEntityOf({ value: { type: 'enum', options: [{ value: 'idle', label: 'Idle' }] } })).toEqual({
      platform: 'sensor',
      deviceClass: null,
      stateClass: null,
      unit: null,
    });
  });
});
