import { describe, expect, test } from 'bun:test';

import { readAutomationYaml, readConfig, readDeviceYaml, schemaLine, writeConfig } from './yaml.ts';

/*
  A whole configuration file: read, written back and read again the same; a
  secret kept by name; and every problem placed where it is in the text — the
  YAML's own, a missing field, inside an expression.
*/

const EXAMPLE = `${schemaLine('http://192.0.2.1:8080/api/config/schema.json')}
kraftverk: 1

home:
  policy: { loadWatts: 50, reserveSoc: 20 }

devices:
  garage-p280:
    type: aferiy.p280
    name: Garage P280
    connect:
      - via: ble
        address: "AA:BB:CC:DD:EE:01"
  smart-plug:
    type: tuya.zigbee-plug
    name: Smart plug
    connect:
      - via: lan
        address: 192.0.2.10#a4c1380000000001
        settings: { deviceId: bf7c0000000000000000zp, protocolVersion: "3.4" }
        secrets: { localKey: !secret smart-plug-key }
  ac-in-meter:
    type: atorch.s1w
    name: AC-IN Battery

links:
  - feeds: { from: ac-in-meter, to: garage-p280.input.ac }

automations:
  start-charging-scooter:
    name: Start charging the scooter
    mode: watch
    clock: Europe/Stockholm
    made from: standard.start-charging
    uses:
      supply: garage-p280.outlet.ac
      charger: smart-plug
    do:
      - turn on: supply
      - wait until: charger reachable
        at most: 2 min
      - turn on: charger
      - make sure: charger.power.draw > 50 W
        within: 20 s
        tries: 5
        each time:
          - turn off: charger
          - wait: 5 s
          - turn on: charger
    if a step fails:
      - turn off: charger
      - turn off: supply
  morning:
    name: Morning
    mode: act
    clock: Europe/Stockholm
    recheck: 15 min
    home page: 0
    uses:
      plug: smart-plug
    when:
      - at: "07:00"
        days: weekdays
    only if: time between 06:00 and 09:00
    do:
      - turn on: plug

secrets:
  smart-plug-key: sealed:v1:c2FsdA:aXY:ZGF0YQ
`;

describe('a configuration file', () => {
  test('read: devices, a secret by name, a link, automations in words', () => {
    const { document, problems, from } = readConfig(EXAMPLE);
    expect(problems).toEqual([]);
    expect(from).toBe(1);
    expect(document!.home.policy).toEqual({ loadWatts: 50, reserveSoc: 20 });
    expect(document!.devices['smart-plug']!.connect[0]).toEqual({
      via: 'lan',
      address: '192.0.2.10#a4c1380000000001',
      settings: { deviceId: 'bf7c0000000000000000zp', protocolVersion: '3.4' },
      secrets: { localKey: { secret: 'smart-plug-key' } },
      exportable: false,
    });
    expect(document!.links).toEqual([{ kind: 'feeds', from: { device: 'ac-in-meter', part: 'main' }, to: { device: 'garage-p280', part: 'input.ac' } }]);
    const morning = document!.automations.morning!;
    expect(morning).toMatchObject({ mode: 'act', recheckMinutes: 15, homePlace: 0 });
    expect(morning.rule.when).toEqual([{ at: { value: '07:00' }, days: ['mon', 'tue', 'wed', 'thu', 'fri'] }]);
    expect(morning.rule.if).toEqual({ within: { from: { value: '06:00' }, to: { value: '09:00' } } });
  });

  test('written back and read again: the same document, its secret still by name', () => {
    const first = readConfig(EXAMPLE).document!;
    const unitOf = (_role: string, means: string) => (means === 'power.draw' ? 'W' : null);
    const text = writeConfig(first, { schemaUrl: 'http://192.0.2.1:8080/api/config/schema.json', unitOf });
    expect(text.split('\n')[0]).toBe('# yaml-language-server: $schema=http://192.0.2.1:8080/api/config/schema.json');
    expect(text).toContain('localKey: !secret smart-plug-key');
    expect(text).toContain('make sure: charger.power.draw > 50 W');
    expect(text).toContain('at: "07:00"');
    const again = readConfig(text);
    expect(again.problems).toEqual([]);
    expect(again.document).toEqual(first);
  });

  test('every problem where it is: a missing field, inside an expression, a wrong key — all at once', () => {
    const text = `kraftverk: 1
devices:
  Smart_Plug:
    type: tuya.zigbee-plug
  ok:
    name: No type
automations:
  a:
    name: A
    clock: Europe/Stockholm
    do:
      - make sure: charger.power.draw >>
        within: 20 s
        tries: 3
`;
    const { document, problems } = readConfig(text);
    expect(document).toBeNull();
    expect(problems.map(({ message, line, column }) => ({ message, line, column }))).toEqual([
      { message: '"Smart_Plug" is not a key: lowercase letters, digits and dashes', line: 4, column: 5 },
      { message: 'Expected its name', line: 4, column: 5 },
      { message: 'Expected its type ("type: acme.plug")', line: 6, column: 5 },
      { message: 'Expected a value, a reading or "(" — not ">"', line: 12, column: 40 },
    ]);
  });

  test('YAML that is not YAML, a missing version, and one written by a newer kraftverk', () => {
    expect(readConfig('devices: [').problems[0]).toMatchObject({ line: 1 });
    expect(readConfig('devices: {}').problems[0]!.message).toBe('The document says which version it is: "kraftverk: 1" at its top');
    expect(readConfig('kraftverk: 9').problems[0]).toMatchObject({ message: 'It was written by a newer kraftverk (version 9); this one reads up to version 1', line: 1, column: 12 });
  });
});

describe('one device or one automation, on its own', () => {
  const DEVICE = 'type: acme.plug\nname: Cellar plug\nconnect:\n  - via: lan\n    address: 192.0.2.10\n';
  const AUTOMATION = 'name: Cellar light\nclock: Europe/Stockholm\nuses:\n  plug: cellar-plug\ndo:\n  - turn on: plug\n';

  test('its own YAML — what its page shows — is read as a file of that one, under a key made from its name', () => {
    const device = readConfig(DEVICE);
    expect(device.problems).toEqual([]);
    expect(device.holds).toEqual({ kind: 'devices', key: 'cellar-plug' });
    expect(Object.keys(device.document!.devices)).toEqual(['cellar-plug']);
    const automation = readConfig(AUTOMATION);
    expect(automation.holds).toEqual({ kind: 'automations', key: 'cellar-light' });
    expect(automation.document!.automations['cellar-light']!.uses).toEqual({ plug: { device: 'cellar-plug', part: 'main' } });
    // Its problems are placed in its own text.
    expect(readConfig(AUTOMATION.replace('turn on: plug', 'wait: forever')).problems).toMatchObject([{ line: 6, column: 18 }]);
    // A file says its version; a map that is neither a file nor one entry is still asked for it.
    expect(readConfig('devices: {}').holds).toBeNull();
  });

  test('a whole file of just that one, pasted where its YAML is written, is read too — under the key the file gives it', () => {
    const file = writeConfig(readConfig(AUTOMATION).document!);
    const read = readAutomationYaml(file, 'anything');
    expect(read.problems).toEqual([]);
    expect(read.key).toBe('cellar-light');
    expect(read.entry!.name).toBe('Cellar light');
    const device = readDeviceYaml(writeConfig(readConfig(DEVICE).document!), 'anything');
    expect(device.key).toBe('cellar-plug');
    // More than one, or devices beside it: that is the Configuration screen's.
    const both = writeConfig({ ...readConfig(DEVICE).document!, automations: readConfig(AUTOMATION).document!.automations });
    expect(readAutomationYaml(both, 'anything').problems.map((problem) => problem.message)).toEqual(['Here is one automation: a file with devices in it is imported under App settings → Configuration']);
  });
});
