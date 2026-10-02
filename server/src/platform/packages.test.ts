import { describe, expect, test } from 'bun:test';

import { checkDeviceTypeContract } from '@kraftverk/device-sdk/testing';

import { DeviceTypeRegistry, ProtocolRegistry, TransportHost } from '@kraftverk/hub';

import { discoverDeviceTypes, discoverProtocols, discoverTransports } from './packages.ts';

/*
  Every installed package keeps its contract (docs/ARCHITECTURE.md, step 15).

  Found the way the server finds them at start, so a package added tomorrow is
  checked here with no edit: its manifest is read, it loads, and it is valid —
  a protocol by validateProtocol, a transport by validateTransportDefinition, a
  device type or service by the contract suite, and every connection method
  names an installed protocol with a binding for an installed transport.
*/

const protocols = new ProtocolRegistry();
const transports = new TransportHost({ platform: 'server', context: { env: {}, log: () => {}, audit: () => {} } });
const types = new DeviceTypeRegistry();
await Promise.all([discoverProtocols(protocols), discoverTransports(transports), discoverDeviceTypes(types)]);
types.checkConnections({ protocol: (id) => protocols.get(id), transport: (id) => transports.definition(id) });

describe('installed packages', () => {
  test('every protocol is valid', () => {
    expect(protocols.refused).toEqual([]);
    expect(protocols.all().length).toBeGreaterThan(0);
  });

  test('every transport is valid', () => {
    expect(transports.refused).toEqual([]);
    expect(transports.definitions().length).toBeGreaterThan(0);
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
