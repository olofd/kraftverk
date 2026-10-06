import { describe, expect, test } from 'bun:test';

import { checkDeviceTypeContract } from '@kraftverk/device-sdk/testing';

import { DeviceTypeRegistry, ProtocolRegistry, TransportHost } from '@kraftverk/hub';

import { discoverIntegrations, discoverTransports } from './packages.ts';

/*
  Every installed package keeps its contract (docs/ARCHITECTURE.md, step 15).

  Found the way the server finds them at start, so a package added tomorrow is
  checked here with no edit: its manifest is read, it loads, and it is valid —
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

describe('installed packages', () => {
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

  for (const type of types.all()) {
    test(`${type.id} keeps the device-type contract`, async () => {
      expect(await checkDeviceTypeContract(type)).toEqual([]);
    }, 30_000);
  }
});
