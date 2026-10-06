import type { Vocabulary } from './vocabulary.ts';

/*
  A vocabulary for tests: made-up types, each reached one way — a station by
  Bluetooth, a plug through a gateway on the home network with a local key, a
  meter on the home network, an account in a cloud, and a lamp reached
  through such an account — and what a server has.
*/

export const VOCABULARY: Vocabulary = {
  types: [
    {
      id: 'acme.station',
      name: 'Acme station',
      settings: { fields: {} },
      parts: ['main', 'outlet.ac', 'input.ac'],
      methods: [{ id: 'ble', label: 'Bluetooth', fixedAddress: null, settings: { fields: {} }, secrets: { fields: {} }, through: [] }],
    },
    {
      id: 'acme.plug',
      name: 'Acme plug',
      settings: { fields: { profile: { type: 'enum', title: 'Profile', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' } } },
      parts: ['main'],
      methods: [
        {
          id: 'lan',
          label: 'Home network',
          fixedAddress: null,
          settings: { fields: { deviceId: { type: 'string', title: 'Device id', required: true }, protocolVersion: { type: 'enum', title: 'Protocol version', options: [{ value: '3.3', label: '3.3' }, { value: '3.4', label: '3.4' }], default: '3.4' } } },
          secrets: { fields: { localKey: { type: 'string', title: 'Local key', required: true, presentation: 'secret' } } },
          through: [],
        },
        { id: 'simulated', label: 'Simulated', fixedAddress: 'simulated', settings: { fields: {} }, secrets: { fields: {} }, through: [] },
      ],
    },
    {
      id: 'acme.meter',
      name: 'Acme meter',
      settings: { fields: {} },
      parts: ['main'],
      methods: [{ id: 'lan', label: 'Home network', fixedAddress: null, settings: { fields: {} }, secrets: { fields: {} }, through: [] }],
    },
    {
      id: 'acme.account',
      name: 'Acme account',
      settings: { fields: {} },
      parts: ['main'],
      methods: [
        {
          id: 'cloud',
          label: 'Acme cloud',
          fixedAddress: 'https://cloud.example.com',
          settings: { fields: { account: { type: 'string', title: 'Account', required: true } } },
          secrets: { fields: { password: { type: 'string', title: 'Password', required: true, presentation: 'secret' } } },
          through: [],
        },
      ],
    },
    {
      id: 'acme.lamp',
      name: 'Acme lamp',
      settings: { fields: {} },
      parts: ['main'],
      methods: [{ id: 'account', label: 'Through the account', fixedAddress: null, settings: { fields: {} }, secrets: { fields: {} }, through: ['acme.account'] }],
    },
  ],
  linkKinds: ['feeds'],
  policy: { loadWatts: { label: 'A load worth confirming', min: 0, max: 5000, unit: 'W' }, reserveSoc: { label: 'A reserve to keep', min: 0, max: 100, unit: '%' } },
  devices: [{ key: 'hall-lamp', type: 'acme.plug', name: 'Hall lamp', parts: ['main'] }],
  automations: [{ key: 'night', name: 'Night' }],
};

/** A whole document, as the owner's charging chain would be written. */
export const DOCUMENT = `kraftverk: 6

home:
  policy: { loadWatts: 50, reserveSoc: 20 }

devices:
  garage-station:
    type: acme.station
    name: Garage station
    connect:
      - via: ble
        address: "AA:BB:CC:DD:EE:01"
  smart-plug:
    type: acme.plug
    name: Smart plug
    connect:
      - via: lan
        address: 192.0.2.10#a4c1380000000001
        settings: { deviceId: bf7c0000000000000000zp, protocolVersion: "3.4" }
        secrets: { localKey: !secret smart-plug-key }
  ac-in-meter:
    type: acme.meter
    name: AC-IN meter
    connect:
      - via: lan
        address: 192.0.2.11

links:
  - feeds: { from: ac-in-meter, to: garage-station.input.ac }

automations:
  start-charging:
    name: Start charging the scooter
    mode: watch
    clock: Europe/Stockholm
    uses:
      supply: garage-station.outlet.ac
      charger: smart-plug
    do:
      - turn on: supply
      - wait until: charger reachable
        at most: 2 min
      - turn on: charger
      - make sure: charger.power > 50 W
        within: 20 s
        tries: 5
        each time:
          - turn off: charger
          - wait: 5 s
          - turn on: charger
    if a step fails:
      - turn off: charger
      - turn off: supply

secrets:
  smart-plug-key: sealed:v1:c2FsdA:aXY:ZGF0YQ
`;
