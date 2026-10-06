import { describe, expect, test } from 'bun:test';

import { MAIN_PART, type DeviceDescription } from '@kraftverk/device-sdk';

import { energyFlowOf } from './energy.ts';

/*
  The energy flow is drawn for any device whose parts say where they sit in
  it: sources, storage and loads, each with what it measures.
*/

const AT = '2026-09-29T12:00:00.000Z';

const STATION: DeviceDescription = {
  parts: [
    { id: MAIN_PART, label: 'Station', kind: 'device', energy: { role: 'storage' } },
    { id: 'input.ac', label: 'Mains', kind: 'input', energy: { role: 'source' } },
    { id: 'outlet.ac', label: 'AC outlets', kind: 'outlet', energy: { role: 'load' }, offers: ['switch'] },
    { id: 'lock', label: 'Lock', kind: 'lock' },
  ],
  attributes: [
    { key: 'soc', label: 'Charge', value: { type: 'number', unit: '%' }, quantity: 'percent', means: 'charge' },
    { key: 'input.ac.volts', part: 'input.ac', label: 'Voltage', value: { type: 'number', unit: 'V' }, quantity: 'voltage', means: 'voltage' },
    { key: 'input.ac.watts', part: 'input.ac', label: 'From mains', value: { type: 'number', unit: 'W' }, quantity: 'power', means: 'mainsInput' },
    { key: 'outlet.ac.on', part: 'outlet.ac', label: 'On', value: { type: 'boolean' }, means: 'on' },
    { key: 'outlet.ac.watts', part: 'outlet.ac', label: 'Draw', value: { type: 'number', unit: 'W' }, quantity: 'power', means: 'power' },
  ],
};

describe('the energy flow', () => {
  test('is each part with a role, with the power it gives or draws, and the charge it keeps', () => {
    const flow = energyFlowOf(STATION, [
      { key: 'soc', value: 64, at: AT },
      { key: 'input.ac.volts', value: 230, at: AT },
      { key: 'input.ac.watts', value: 600, at: AT },
      { key: 'outlet.ac.watts', value: 40, at: AT },
    ]);
    expect(flow && Object.fromEntries(Object.entries(flow).map(([role, nodes]) => [role, nodes.map((node) => [node.part.id, node.watts, node.soc])]))).toEqual({
      source: [['input.ac', 600, null]],
      storage: [[MAIN_PART, null, 64]],
      load: [['outlet.ac', 40, null]],
    });
  });

  test('says unknown as unknown: no reading is no figure, not a zero', () => {
    expect(energyFlowOf(STATION, [])?.source[0]?.watts).toBeNull();
  });

  test('is nothing for a device none of whose parts has a place in one', () => {
    expect(energyFlowOf({ parts: [{ id: MAIN_PART, label: 'Lock', kind: 'lock' }], attributes: [] }, [])).toBeNull();
  });
});
