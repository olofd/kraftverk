import { describe, expect, test } from 'bun:test';

import type { Vocabulary } from '@kraftverk/home-file';
import { automationId, MAIN_PART, savedDeviceId } from '@kraftverk/device-sdk';
import type { Rule } from '@kraftverk/automation';

import { automationYaml, deviceYaml, draftOfEntry, readAutomationText } from './config.ts';
import type { DeviceView } from '@kraftverk/api-contract';

/*
  An automation's YAML in the app's editor: written from what the app is
  shown, read back to the very draft it came from — numbers in the unit of
  what is read — and a key naming nothing here said at its line. A device's
  YAML names its secrets, never their values.
*/

const plug = {
  id: savedDeviceId('d-plug'),
  key: 'scooter-plug',
  typeId: 'acme.plug',
  name: 'Scooter plug',
  identity: null,
  removedAt: null,
  pausedAt: null,
  trackDays: null,
  picture: 'type:0',
  config: { profile: 'b' },
  description: {
    parts: [{ id: MAIN_PART, label: 'Plug', kind: 'outlet', offers: ['switch', 'powerMeter'] }],
    attributes: [{ key: 'power', label: 'Power', value: { type: 'number', unit: 'W' }, means: 'power' }],
  },
  connections: [
    { id: 'c-1', method: 'lan', methodLabel: 'Home network', heldBy: { kind: 'master', id: 'n-000000000000000000000000A1', name: 'Test machine' }, through: null, address: '192.0.2.10#a4c1380000000001', priority: 0, secrets: ['localKey'], secretsExportable: false, config: { deviceId: 'made-up-id' } },
    { id: 'c-2', method: 'bluetooth', methodLabel: 'Bluetooth', heldBy: { kind: 'node', id: 'n-000000000000000000000000B2', name: 'A phone' }, through: null, address: 'AA:BB', priority: 1, secrets: [], secretsExportable: false, config: {} },
  ],
} as unknown as DeviceView;

const VOCABULARY: Vocabulary = {
  types: [
    {
      id: 'acme.plug',
      name: 'Acme plug',
      settings: { fields: { profile: { type: 'enum', title: 'Profile', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'a' } } },
      parts: ['main'],
      methods: [{ id: 'lan', label: 'Home network', fixedAddress: null, settings: { fields: { deviceId: { type: 'string', title: 'Device id', required: true } } }, secrets: { fields: { localKey: { type: 'string', title: 'Local key', required: true, presentation: 'secret' } } }, through: [] }],
    },
  ],
  linkKinds: ['feeds'],
  policy: {},
  devices: [{ key: 'scooter-plug', type: 'acme.plug', name: 'Scooter plug', parts: ['main'] }],
  automations: [{ key: 'night', name: 'Night' }],
  homes: [],
};

const rule: Rule = {
  roles: { charger: { label: 'Charger', capabilities: ['switch', 'powerMeter'] } },
  params: { fields: {} },
  when: [],
  then: [
    { command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { value: true } } } },
    { waitUntil: { condition: { compare: 'gt', left: { read: { role: 'charger', means: 'power' } }, right: { value: 50, unit: 'W' } }, atMost: { value: 20, unit: 's' } } },
  ],
};

const automation = {
  name: 'Charge',
  rule,
  roles: { charger: { device: plug.id, part: MAIN_PART } },
  groups: {}, starts: {},
  madeFrom: null,
  mode: 'act' as const,
  homeId: null,
  timeZone: 'Europe/Stockholm',
  recheckMinutes: null,
};

describe('an automation as YAML, in the app', () => {
  test('is written as the server writes it, and read back to the draft it came from', () => {
    const text = automationYaml(automation, [plug], []);
    expect(text).toContain('mode: act');
    // It reads the plug's power as well as switching it: what it needs is said.
    expect(text).toContain('  charger:\n    part: scooter-plug\n    needs:\n      - switch\n      - powerMeter\n');
    expect(text).toContain('wait until: charger.power > 50 W');
    const read = readAutomationText(text, 'charge', VOCABULARY);
    expect(read.problems).toEqual([]);
    const { draft, settings } = draftOfEntry(read.entry!, [plug], []);
    expect(draft).toEqual({ name: 'Charge', rule, roles: automation.roles, groups: {}, starts: {} });
    expect(settings).toEqual({ mode: 'act', homeId: null, timeZone: 'Europe/Stockholm', recheckMinutes: null });
  });

  test('a key naming no device here is a problem at its line; an automation it starts is found by its key', () => {
    const text = 'name: Charge\nclock: Europe/Stockholm\nuses:\n  charger: cellar-plug\n  later: { automation: night }\ndo:\n  - turn on: charger\n  - start: later\n';
    const read = readAutomationText(text, 'charge', VOCABULARY);
    expect(read.entry).toBeNull();
    expect(read.problems).toEqual([{ message: 'There is no device "cellar-plug", in the file or on the server', path: ['uses', 'charger'], line: 4, column: 12 }]);
    const fine = readAutomationText(text.replace('cellar-plug', 'scooter-plug'), 'charge', VOCABULARY);
    expect(fine.problems).toEqual([]);
    const { draft } = draftOfEntry(fine.entry!, [plug], [{ id: automationId('a-night'), key: 'night' }]);
    expect(draft.starts).toEqual({ later: automationId('a-night') });
  });
});

describe('a device as YAML, in the app', () => {
  test('names its secrets, never their values, and leaves out a way an app holds', () => {
    const { text, secrets, heldElsewhere } = deviceYaml(plug, VOCABULARY);
    expect(text).toBe(
      'type: acme.plug\nname: Scooter plug\nsettings:\n  profile: b\nconnect:\n  - via: lan\n    address: 192.0.2.10#a4c1380000000001\n    settings:\n      deviceId: made-up-id\n    secrets:\n      localKey: !secret scooter-plug.localKey\n'
    );
    expect(secrets).toBe(1);
    expect(heldElsewhere).toBe(1);
  });
});
