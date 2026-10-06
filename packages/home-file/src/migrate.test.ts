import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CURRENT_VERSION, MIGRATIONS } from './migrate.ts';
import { readConfig, writeConfig } from './yaml.ts';

/*
  The configuration is versioned on purpose (AGENTS.md): it is what carries
  a home across a database reset, so every newer kraftverk reads every older
  file. Made a mechanism, not a promise: each version has a fixture kept as
  that version wrote it (fixtures/vN.yaml, never changed), each version below
  this one a migration to the next — and every fixture reads, here and now,
  with nothing wrong, and comes back the same when written again.
*/

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const fixture = (version: number) => join(FIXTURES, `v${version}.yaml`);

describe('every version of the document', () => {
  test('has a kept fixture, and every one below this has a migration to the next', () => {
    for (let version = 1; version <= CURRENT_VERSION; version++) {
      expect(existsSync(fixture(version)), `fixtures/v${version}.yaml: keep a file version ${version} wrote`).toBe(true);
      if (version < CURRENT_VERSION) expect(MIGRATIONS[version], `MIGRATIONS[${version}]: the way from version ${version} to ${version + 1}`).toBeDefined();
    }
    // None for a version that does not exist yet.
    expect(Object.keys(MIGRATIONS).map(Number).filter((version) => version >= CURRENT_VERSION)).toEqual([]);
    expect(existsSync(fixture(CURRENT_VERSION + 1))).toBe(false);
  });

  for (let version = 1; version <= CURRENT_VERSION; version++) {
    test(`version ${version}'s fixture is read by this kraftverk — with nothing wrong — and written back the same`, () => {
      const read = readConfig(readFileSync(fixture(version), 'utf8'));
      expect(read.problems).toEqual([]);
      expect(read.from).toBe(version);
      const document = read.document!;
      // Something of each part survives, whatever the version.
      expect(Object.keys(document.devices).length).toBeGreaterThan(0);
      expect(Object.keys(document.automations).length).toBeGreaterThan(0);
      expect(document.links.length).toBeGreaterThan(0);
      const again = readConfig(writeConfig(document));
      expect(again.problems).toEqual([]);
      expect(again.document).toEqual(document);
    });
  }

  test('the home\'s clock keeps time for an automation that says none of its own', () => {
    const document = readConfig(readFileSync(fixture(1), 'utf8')).document!;
    expect(document.home.clock).toBe('Europe/Stockholm');
    expect(document.automations['stop-charging']!.clock).toBe('Europe/Stockholm');
    // Without one, an automation says its own.
    expect(readConfig('kraftverk: 4\nautomations:\n  a:\n    name: A\n    do: []\n').problems.map((problem) => problem.message)).toEqual([
      'Expected its clock: the time zone its times are in ("clock: Europe/Stockholm"), or the home\'s ("home: { clock: … }")',
    ]);
  });

  test('a role’s description, which version 2 kept from the recipe, is left with the recipe: what fills it, its label and what it needs stay', () => {
    const text = `kraftverk: 2
automations:
  window:
    name: Window
    clock: Europe/Stockholm
    uses:
      battery:
        part: station
        description: "Anything that reports its charge"
      charger:
        part: plug
        label: What charges it
        description: A plug that feeds it
    when:
      - becomes: battery.charge < 20 %
        do:
          - turn on: charger
    do: []
`;
    const read = readConfig(text);
    expect(read.problems).toEqual([]);
    expect(read.from).toBe(2);
    expect(read.document!.automations.window!.rule.roles).toEqual({ battery: { label: 'Battery', capabilities: ['battery'] }, charger: { label: 'What charges it', capabilities: ['switch'] } });
    expect(writeConfig(read.document!)).not.toContain('description');
  });

  test('a setting is setting.low and a package’s function its id alone, as version 4 writes them — a quoted text kept as it is', () => {
    const text = `kraftverk: 3
automations:
  window:
    name: Window
    clock: Europe/Stockholm
    uses:
      charger: plug
      forecast: weather
    when:
      - becomes: charger.power > $low
    only if: call acme.weather.sunny(forecast, day = "call $tomorrow") == "yes"
    do:
      - turn on: charger
`;
    const read = readConfig(text);
    expect(read.from).toBe(3);
    const rule = read.document!.automations.window!.rule;
    expect(rule.when[0]).toEqual({ becomes: { compare: 'gt', left: { read: { role: 'charger', means: 'power' } }, right: { param: 'low' } } });
    expect(rule.if).toEqual({
      compare: 'eq',
      left: { call: 'acme.weather.sunny', role: 'forecast', args: { day: { value: 'call $tomorrow' } } },
      right: { value: 'yes' },
    });
  });
});
