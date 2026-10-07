import { describe, expect, test } from 'bun:test';

import { asJson, entryOf } from '@kraftverk/device-sdk';
import { checkDeviceTypeContract } from '@kraftverk/device-sdk/testing';

import { DeviceTypeRegistry, ProtocolRegistry, TransportHost } from '@kraftverk/hub';

import { discoverIntegrations, discoverTransports } from './packages.ts';

/*
  Every installed package keeps its contract (docs/ARCHITECTURE.md, step 15).

  Found the way the server finds them at start — from their manifests and
  catalogues, none of their code imported — and then each loaded, so a
  package added tomorrow is checked here with no edit: its manifest is read,
  its catalogue is its code's, it loads, and it is valid —
  a protocol by validateProtocol, a transport by validateTransportDefinition, an
  integration and every device package on it by their manifests and every type
  they declare by the contract suite, and every connection method names an
  installed protocol with a binding for an installed transport.
*/

const protocols = new ProtocolRegistry();
const transports = new TransportHost({ platform: 'system', context: { env: {}, log: () => {}, audit: () => {} } });
const types = new DeviceTypeRegistry();
await Promise.all([discoverTransports(transports), discoverIntegrations({ types, protocols })]);
types.checkConnections({ protocols, transport: (id) => transports.definition(id) });
/** What was loaded by finding them: nothing, as the server starts. */
const loadedAtStart = types.loadedIntegrations();
/** Each type as its catalogue says, before its code is there to say otherwise. */
const catalogued = new Map(types.all().map((type) => [type.id, type]));
// Every integration loaded — one with no types yet too, its protocols only.
await Promise.all(types.integrations().map((integration) => types.loadIntegration(integration.id)));
const loaded = types.all().map((type) => types.loaded(type.id));

describe('installed packages', () => {
  test('are found without importing any of their code: each loads when first needed', () => {
    expect(loadedAtStart).toEqual([]);
    expect(types.loadedIntegrations()).toEqual(types.integrations().map((integration) => integration.id));
  });

  test('every protocol is valid', () => {
    expect(protocols.refused).toEqual([]);
    expect(protocols.all().length).toBeGreaterThan(0);
  });

  test('every transport is valid', () => {
    expect(transports.refused).toEqual([]);
    expect(transports.definitions().length).toBeGreaterThan(0);
  });

  test('every integration loads, with its own types and the products on it', () => {
    expect(types.refused).toEqual([]);
    expect(types.integrations().length).toBeGreaterThan(0);
    for (const type of types.all()) {
      const source = types.sourceOf(type.id);
      expect(source && types.integrations().some((integration) => integration.id === source.integration.id)).toBe(true);
    }
  });

  test('every device type loads, and every method it declares can be made', () => {
    expect(types.refused).toEqual([]);
    for (const type of types.all()) expect({ type: type.id, problems: types.warnings(type.id) }).toEqual({ type: type.id, problems: [] });
  });

  test('every type loads, and its catalogue is its code', () => {
    expect(loaded.map((type, index) => type?.id ?? `${types.all()[index]!.id} would not load`)).toEqual(types.all().map((type) => type.id));
    for (const type of loaded) expect(asJson(entryOf(type!))).toEqual(catalogued.get(type!.id)!);
    for (const protocol of protocols.all()) expect(protocols.loaded(protocol.id)).not.toBeNull();
  });

  for (const type of loaded) {
    test(`${type!.id} keeps the device-type contract`, async () => {
      expect(await checkDeviceTypeContract(type!)).toEqual([]);
    }, 30_000);
  }
});
