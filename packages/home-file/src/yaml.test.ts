import { describe, expect, test } from 'bun:test';

import { readAutomationYaml, readConfig, readDeviceYaml, schemaLine, writeConfig } from './yaml.ts';

/*
  A whole configuration file: read, written back and read again the same; a
  secret kept by name; and every problem placed where it is in the text — the
  YAML's own, a missing field, inside an expression.
*/

const EXAMPLE = `${schemaLine('http://192.0.2.1:8080/api/config/schema.json')}
kraftverk: 4

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
    expect(from).toBe(4);
    expect(document!.homes.home!.policy).toEqual({ loadWatts: 50, reserveSoc: 20 });
    expect(document!.devices['smart-plug']!.connect[0]).toEqual({
      via: 'lan',
      through: null,
      address: '192.0.2.10#a4c1380000000001',
      settings: { deviceId: 'bf7c0000000000000000zp', protocolVersion: '3.4' },
      secrets: { localKey: { secret: 'smart-plug-key' } },
      exportable: false,
    });
    expect(document!.links).toEqual([{ kind: 'feeds', from: { device: 'ac-in-meter', part: 'main' }, to: { device: 'garage-p280', part: 'input.ac' } }]);
    const morning = document!.automations.morning!;
    expect(morning).toMatchObject({ mode: 'act', recheckMinutes: 15 });
    expect(morning.rule.when).toEqual([{ at: { value: '07:00' }, days: ['mon', 'tue', 'wed', 'thu', 'fri'] }]);
    expect(morning.rule.if).toEqual({ within: { from: { value: '06:00' }, to: { value: '09:00' } } });
  });

  test('written back and read again: the same document, its secret still by name', () => {
    const first = readConfig(EXAMPLE).document!;
    const text = writeConfig(first, { schemaUrl: 'http://192.0.2.1:8080/api/config/schema.json' });
    expect(text.split('\n')[0]).toBe('# yaml-language-server: $schema=http://192.0.2.1:8080/api/config/schema.json');
    expect(text).toContain('localKey: !secret smart-plug-key');
    expect(text).toContain('make sure: charger.power > 50 W');
    expect(text).toContain('at: "07:00"');
    const again = readConfig(text);
    expect(again.problems).toEqual([]);
    expect(again.document).toEqual(first);
  });

  test('every problem where it is: a missing field, inside an expression, a wrong key — all at once', () => {
    const text = `kraftverk: 4
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
      - make sure: charger.power >>
        within: 20 s
        tries: 3
`;
    const { document, problems } = readConfig(text);
    expect(document).toBeNull();
    expect(problems.map(({ message, line, column }) => ({ message, line, column }))).toEqual([
      { message: '"Smart_Plug" is not a key: lowercase letters, digits and dashes', line: 4, column: 5 },
      { message: 'Expected its name', line: 4, column: 5 },
      { message: 'Expected its type ("type: acme.plug")', line: 6, column: 5 },
      { message: 'Expected a value, a reading or "(" — not ">"', line: 12, column: 35 },
    ]);
  });

  test('where a home is: its latitude, longitude and geofence, written back as they were — and each held to the globe', () => {
    const located = readConfig('kraftverk: 4\nhome:\n  location: { latitude: 51.4779, longitude: -0.0015 }\n');
    expect(located.problems).toEqual([]);
    expect(located.document!.homes.home!.location).toEqual({ latitude: 51.4779, longitude: -0.0015, radius: null });
    expect(readConfig(writeConfig(located.document!)).document!.homes.home!.location).toEqual({ latitude: 51.4779, longitude: -0.0015, radius: null });
    const home = (location: string) => `kraftverk: 17\nhomes:\n  home:\n    name: Home\n    time zone: Europe/London\n    location: ${location}\n`;
    expect(readConfig(home('{ latitude: 51.4779, longitude: -0.0015, radius: 200 }')).document!.homes.home!.location).toEqual({ latitude: 51.4779, longitude: -0.0015, radius: 200 });
    const wrong = (location: string) => readConfig(home(location)).problems.map((problem) => problem.message);
    expect(wrong('{ latitude: 95, longitude: 0 }')).toEqual(['A latitude is a number from -90 to 90']);
    expect(wrong('{ latitude: 51, longitude: "east" }')).toEqual(['A longitude is a number from -180 to 180']);
    expect(wrong('{ latitude: 51, longitude: 0, radius: 0 }')).toEqual(['A radius is metres, from 1 to 50 000']);
    expect(wrong('{ lat: 51, lon: 0 }')).toEqual(['"location" is its latitude and longitude, in degrees, and a radius in metres: { latitude: 59.3, longitude: 18.1, radius: 150 }']);
  });

  test('a home’s spaces, its openings, and where a device stands: read, written back the same, and held to the home', () => {
    const text = [
      'kraftverk: 17',
      'homes:',
      '  home:',
      '    name: Home',
      '    time zone: Europe/Stockholm',
      '    spaces:',
      '      house:',
      '        kind: building',
      '        name: House',
      '        spaces:',
      '          ground:',
      '            kind: floor',
      '            name: Ground floor',
      '            level: 0',
      '            plan: { picture: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, scale: 0.02, x: -1, y: 12 }',
      '            spaces:',
      '              kitchen: { kind: room, name: Kitchen, purpose: kitchen, height: 2.4, frame: { x: 4, y: 0, turn: 90 }, outline: [[0, 0], [4.2, 0], [4.2, 3.5], [0, 3.5]] }',
      '              hall: { kind: room, name: Hall }',
      '      garden: { kind: outdoor, name: Garden }',
      '    openings:',
      '      front-door: { kind: door, from: hall, to: outside, name: Front door, shape: [[0, 1], [0, 1.9]] }',
      '      kitchen-door: { kind: opening, from: hall, to: kitchen }',
      'devices:',
      '  lamp:',
      '    type: acme.lamp',
      '    name: Lamp',
      '    place: { home: home, space: kitchen, at: [1.5, 2], height: 1.1, facing: 90 }',
      '  car:',
      '    type: acme.car',
      '    name: Car',
      '    based: { home: home, space: garden }',
      '',
    ].join('\n');
    const read = readConfig(text);
    expect(read.problems).toEqual([]);
    const home = read.document!.homes.home!;
    expect(home.spaces.map((space) => [space.key, space.kind, space.spaces.map((inner) => inner.key)])).toEqual([
      ['house', 'building', ['ground']],
      ['garden', 'outdoor', []],
    ]);
    expect(home.spaces[0]!.spaces[0]!.spaces[0]).toEqual({
      key: 'kitchen',
      kind: 'room',
      name: 'Kitchen',
      purpose: 'kitchen',
      icon: null,
      level: null,
      elevation: null,
      height: 2.4,
      frame: { x: 4, y: 0, turn: 90 },
      outline: [
        [0, 0],
        [4.2, 0],
        [4.2, 3.5],
        [0, 3.5],
      ],
      plan: null,
      labels: [],
      spaces: [],
    });
    expect(home.spaces[0]!.spaces[0]!.plan).toEqual({ picture: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', scale: 0.02, x: -1, y: 12, turn: 0 });
    expect(home.openings).toEqual({
      'front-door': {
        kind: 'door',
        from: 'hall',
        to: null,
        name: 'Front door',
        shape: [
          [0, 1],
          [0, 1.9],
        ],
      },
      'kitchen-door': { kind: 'opening', from: 'hall', to: 'kitchen', name: null, shape: null },
    });
    expect(read.document!.devices.lamp!.place).toEqual({ home: 'home', space: 'kitchen', opening: null, role: 'stands', at: [1.5, 2], height: 1.1, facing: 90 });
    expect(read.document!.devices.car!.place).toEqual({ home: 'home', space: 'garden', opening: null, role: 'based', at: null, height: null, facing: null });
    expect(readConfig(writeConfig(read.document!)).document).toEqual(read.document);

    const wrong = (from: string, to: string) => readConfig(text.replace(from, to)).problems.map((problem) => problem.message);
    expect(wrong('kitchen-door: { kind: opening, from: hall', 'kitchen-door: { kind: opening, from: cellar')).toEqual(['"from" is the key of a space of this home, or "site"']);
    // A gate in the fence: from the site, the home itself, to the outside — written back as it was.
    const gated = readConfig(text.replace('kitchen-door: { kind: opening, from: hall', 'gate: { kind: gate, from: site, to: outside }\n      kitchen-door: { kind: opening, from: hall'));
    expect(gated.problems).toEqual([]);
    expect(gated.document!.homes.home!.openings.gate).toEqual({ kind: 'gate', from: 'site', to: null, name: null, shape: null });
    expect(readConfig(writeConfig(gated.document!)).document).toEqual(gated.document);
    // A turn kept from 0 to below 360; the same point twice in a row is no outline.
    expect(readConfig(text.replace('turn: 90', 'turn: -270')).document!.homes.home!.spaces[0]!.spaces[0]!.spaces[0]!.frame).toEqual({ x: 4, y: 0, turn: 90 });
    expect(wrong('[4.2, 0]', '[0, 0]')).toContain('An outline has the same point twice in a row');
    expect(wrong('garden: { kind: outdoor', 'kitchen: { kind: outdoor')[0]).toBe('"kitchen" is another space\'s key in this home already');
    expect(wrong('{ kind: room, name: Kitchen', '{ kind: room, level: 1, name: Kitchen')).toEqual(['Only a floor has a level and an elevation']);
    expect(wrong('outline: [[0, 0], [4.2, 0], [4.2, 3.5], [0, 3.5]]', 'outline: [[0, 0], [4.2, 0]]')).toEqual(['An outline has 3 to 200 points']);
    expect(wrong('frame: { x: 4, y: 0, turn: 90 }', 'frame: { x: 4 }')).toEqual(['A frame is { x, y, turn }: its origin in metres, its turn in degrees']);
    expect(wrong('space: kitchen, at: [1.5, 2], height: 1.1, facing: 90', 'space: kitchen, height: 1.1')).toEqual(['A height or a facing is of a point: say "at" too']);
    expect(wrong('    based: { home: home', '    place: { home: home, space: hall }\n    based: { home: home')).toEqual(['A device stands somewhere, or is based somewhere: one of "place" and "based"']);
  });

  test('YAML that is not YAML, a missing version, and one written by a newer kraftverk', () => {
    expect(readConfig('devices: [').problems[0]).toMatchObject({ line: 1 });
    expect(readConfig('devices: {}').problems[0]!.message).toBe('The document says which version it is: "kraftverk: 17" at its top');
    expect(readConfig('kraftverk: 18').problems[0]).toMatchObject({ message: 'It was written by a newer kraftverk (version 18); this one reads up to version 17', line: 1, column: 12 });
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
