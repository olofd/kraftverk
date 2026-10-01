import { describe, expect, test } from 'bun:test';

import { checkDocument } from './check.ts';
import { DOCUMENT, VOCABULARY } from './testing.ts';
import { readAutomationYaml, readConfig, writeAutomationYaml } from './yaml.ts';

/*
  What a file means, checked: each type installed and reached a way it is,
  its settings and secrets what that way needs, and every link and every
  automation naming devices, parts and automations there are — each problem
  at its line, in a whole file and in one automation's own YAML.
*/

const check = (document: Parameters<typeof checkDocument>[0]) => checkDocument(document, VOCABULARY);

describe('what a file means', () => {
  test('a whole charging chain means nothing wrong', () => {
    const read = readConfig(DOCUMENT, {}, check);
    expect(read.problems).toEqual([]);
    expect(Object.keys(read.document!.devices)).toEqual(['garage-station', 'smart-plug', 'ac-in-meter']);
  });

  test('every problem at its line: a type, a way, a setting, a secret, a device, a part, an automation, a clock, a policy', () => {
    const text = DOCUMENT.replace('type: acme.meter', 'type: acme.toaster')
      .replace('{ deviceId: bf7c0000000000000000zp, protocolVersion: "3.4" }', '{ deviceId: bf7c0000000000000000zp, protocolVersion: "9.9", colour: red }')
      .replace('localKey: !secret smart-plug-key', 'localKey: !secret no-such-key')
      .replace('      - via: ble\n        address: "AA:BB:CC:DD:EE:01"', '      - via: ble')
      .replace('to: garage-station.input.ac', 'to: garage-station.input.dc')
      .replace('charger: smart-plug', 'charger: smart-plug\n      other: { automation: dawn }')
      .replace('clock: Europe/Stockholm', 'clock: Europe/Atlantis')
      .replace('loadWatts: 50', 'loadWatts: 50000');
    const { document, problems } = readConfig(text, {}, check);
    expect(document).toBeNull();
    expect(problems.map(({ message, line }) => `${line}: ${message}`)).toEqual([
      '4: A load worth confirming is from 0 to 5000 W',
      '11: Bluetooth needs an address: where it is found',
      '18: Home network has no setting "colour": it has deviceId, protocolVersion',
      '18: Protocol version must be one of: 3.3, 3.4',
      '19: There is no secret called "no-such-key": under "secrets", or in the secrets kept beside the file',
      '21: No installed device type is called "acme.toaster"',
      '28: Garage station has no part "input.dc": it has main, outlet.ac, input.ac',
      '34: "Europe/Atlantis" is not a time zone: "Europe/Stockholm"',
      '38: There is no automation "dawn", in the file or on the server',
    ]);
  });

  test('a device the server has may be named without being in the file; one neither has may not', () => {
    const text = DOCUMENT.replace('charger: smart-plug', 'charger: hall-lamp').replace('supply: garage-station.outlet.ac', 'supply: cellar-station');
    expect(readConfig(text, {}, check).problems.map((problem) => problem.message)).toEqual(['There is no device "cellar-station", in the file or on the server']);
  });
});

describe('one automation’s own YAML', () => {
  test('written as its page shows it, and read back the same', () => {
    const entry = readConfig(DOCUMENT).document!.automations['start-charging']!;
    const text = writeAutomationYaml(entry, { unitOf: (_role, means) => (means === 'power.draw' ? 'W' : null) });
    expect(text.split('\n').slice(0, 4)).toEqual(['name: Start charging the scooter', 'mode: watch', 'clock: Europe/Stockholm', 'uses:']);
    const read = readAutomationYaml(text, 'start-charging');
    expect(read.problems).toEqual([]);
    expect(read.entry).toEqual(entry);
  });

  test('its problems placed in its own text — and the devices it names checked against the server’s', () => {
    const text = `name: Hall at night
clock: Europe/Stockholm
uses:
  lamp: hall-lamp
  other: garage-station
do:
  - turn on: lamp
  - wait until: lamp reachable
`;
    const read = readAutomationYaml(text, 'hall', {}, check);
    expect(read.entry).toBeNull();
    expect(read.problems.map(({ message, line }) => `${line}: ${message}`)).toEqual(['8: "wait until" needs "at most": every wait has its limit']);
    const fixed = readAutomationYaml(text.replace('reachable\n', 'reachable\n    at most: 1 min\n'), 'hall', {}, check);
    expect(fixed.problems.map(({ message, line }) => `${line}: ${message}`)).toEqual(['5: There is no device "garage-station", in the file or on the server']);
  });
});
