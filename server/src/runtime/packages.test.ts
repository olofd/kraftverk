import { describe, expect, test } from 'bun:test';

import { asDeviceTypeV4 } from '@kraftverk/device-sdk';
import { checkDeviceTypeContract, checkDeviceTypeV4Contract } from '@kraftverk/device-sdk/testing';

import { DeviceTypeRegistry } from '../devices/types.ts';
import { ProtocolRegistry } from './protocols.ts';
import { TransportHost } from './transports.ts';

/*
  Every installed package keeps its contract (docs/ARCHITECTURE.md, step 15).

  Found the way the server finds them at start, so a package added tomorrow is
  checked here with no edit: its manifest is read, it loads, and it is valid —
  a protocol by validateProtocol, a transport by validateTransportDefinition, a
  device type or service by the contract suite, and every connection method
  names an installed protocol with a binding for an installed transport.
*/

const protocols = new ProtocolRegistry();
const transports = new TransportHost({ enabled: () => ({ ok: true }), context: { env: {}, log: () => {}, audit: () => {} } });
const types = new DeviceTypeRegistry();
await Promise.all([protocols.discover(), transports.discover(), types.discover()]);
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

    // The device model every holder is moving to (docs/ARCHITECTURE.md §8 step 24),
    // through the adapter until the package is written against it.
    test(`${type.id} keeps the device-model contract, version 4`, async () => {
      expect(await checkDeviceTypeV4Contract(asDeviceTypeV4(type))).toEqual([]);
    }, 30_000);
  }
});
