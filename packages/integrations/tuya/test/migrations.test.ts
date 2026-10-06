import { expect, test } from 'bun:test';

import migrations from '../src/migrations.ts';

/*
  A file kept before a Tuya gateway was a device of its own comes back with
  one: each Zigbee socket reached through it by its Zigbee address, two
  behind one gateway sharing it and its key; a socket on Wi-Fi left as it is.
*/

const installed = [
  { id: 'tuya.plug', methods: [{ id: 'lan', through: [] }, { id: 'gateway', through: ['tuya.gateway'] }] },
  { id: 'acme.zigbee', methods: [{ id: 'gateway', through: ['tuya.gateway'] }] },
  { id: 'tuya.gateway', methods: [{ id: 'lan', through: [] }] },
];

const secret = { secret: 'fan.localKey' };

test('Zigbee sockets at a gateway address become sockets through a gateway entry of their own', () => {
  const [step] = migrations;
  expect(step!.from).toBe(6);
  const migrated = step!.migrate(
    {
      kraftverk: 6,
      devices: {
        fan: { type: 'acme.zigbee', name: 'Fan plug', connect: [{ via: 'lan', address: '192.0.2.74#A4C1380000000001', settings: { deviceId: 'made-up-plug-id', protocolVersion: '3.4' }, secrets: { localKey: secret } }] },
        lamp: { type: 'tuya.plug', name: 'Lamp plug', connect: [{ via: 'lan', address: '192.0.2.74#a4c1380000000002', settings: { deviceId: 'made-up-plug-two', protocolVersion: '3.4' }, secrets: { localKey: secret } }] },
        heater: { type: 'tuya.plug', name: 'Heater plug', connect: [{ via: 'lan', address: '192.0.2.80', settings: { deviceId: 'made-up-wifi-plug' } }] },
      },
    },
    installed
  );
  const devices = migrated.devices as Record<string, { type?: string; name?: string; connect: unknown[] }>;
  expect(devices['tuya-gateway']).toEqual({
    type: 'tuya.gateway',
    name: 'Tuya gateway',
    // The gateway's key and version — never a plug's own device id.
    connect: [{ via: 'lan', address: '192.0.2.74', settings: { protocolVersion: '3.4' }, secrets: { localKey: secret } }],
  });
  expect(devices.fan!.connect).toEqual([{ via: 'gateway', through: 'tuya-gateway', address: 'a4c1380000000001' }]);
  expect(devices.lamp!.connect).toEqual([{ via: 'gateway', through: 'tuya-gateway', address: 'a4c1380000000002' }]);
  expect(devices.heater!.connect).toEqual([{ via: 'lan', address: '192.0.2.80', settings: { deviceId: 'made-up-wifi-plug' } }]);
  expect(Object.keys(devices).filter((key) => key.startsWith('tuya-gateway'))).toEqual(['tuya-gateway']);
});
