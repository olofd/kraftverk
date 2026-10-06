import { expect, test } from 'bun:test';

import { checkDeviceTypeContract } from '@kraftverk/device-sdk/testing';
import common from '@kraftverk/integration-niu/scooter';

import uqiGt from '../src/type.ts';

test('the UQi GT keeps the device-type contract', async () => {
  expect(await checkDeviceTypeContract(uqiGt)).toEqual([]);
});

test('it is the common NIU scooter in all but its name: the same description, ways in and tools', () => {
  expect(uqiGt.id).toBe('niu.uqi-gt');
  expect(uqiGt.meta).toMatchObject({ brand: 'NIU', category: 'vehicle', models: expect.arrayContaining(['UQi GT Sport', 'UQi-GT Citi']) });
  expect(uqiGt.describe({})).toEqual(common.describe({}));
  expect(uqiGt.connections).toEqual(common.connections);
  expect(Object.keys(uqiGt.tools ?? {})).toEqual(Object.keys(common.tools ?? {}));
  // The common one claims no model, so a UQi GT is offered as itself.
  expect(common.meta.models ?? []).toEqual([]);
});
