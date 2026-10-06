import { expect, test } from 'bun:test';

import type { DeviceTypeListing } from '@kraftverk/api-contract';

import { byPlatform, whereTheyRun } from './integrations.ts';

const acme = { id: 'acme', name: 'Acme' };
const listing = (id: string, product: boolean, placements: DeviceTypeListing['placements']) => ({ id, source: { integration: acme, product }, placements }) as unknown as DeviceTypeListing;

test('a platform with its products first and its own types after; one with neither is still listed', () => {
  const generic = listing('acme.plug', false, []);
  const product = listing('brand.plug', true, []);
  const bare = { id: 'bare', name: 'Bare' };
  expect(byPlatform({ integrations: [acme, bare], types: [product, generic] })).toEqual([
    { integration: acme, products: [product], own: [generic] },
    { integration: bare, products: [], own: [] },
  ]);
});

test('where types run: every platform a way of theirs can be held on, apart from what its node must be, each reason once', () => {
  const cloud = listing('acme.cloud', false, [{ method: 'api', platforms: ['system', 'web', 'native'], needs: { trusted: 'its password stays at home' } }]);
  const local = listing('brand.plug', true, [
    { method: 'lan', platforms: ['system'], needs: {} },
    { method: 'again', platforms: ['system'], needs: { trusted: 'its password stays at home', alwaysOn: 'it is read at night' } },
  ]);
  expect(whereTheyRun([local])).toEqual({ platforms: ['system'], needs: [{ trait: 'alwaysOn', why: ['it is read at night'] }, { trait: 'trusted', why: ['its password stays at home'] }] });
  expect(whereTheyRun([cloud, local]).platforms).toEqual(['system', 'web', 'native']);
  expect(whereTheyRun([]).platforms).toEqual([]);
});
