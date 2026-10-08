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

  test('the home\'s clock keeps time for an automation that says none of its own: version 9\'s home is version 10\'s first', () => {
    const document = readConfig(readFileSync(fixture(1), 'utf8')).document!;
    expect(Object.keys(document.homes)).toEqual(['home']);
    expect(document.homes.home!.timeZone).toBe('Europe/Stockholm');
    // It said none: it keeps its home's.
    expect(document.automations['stop-charging']!.clock).toBeNull();
    // With no home's clock said, the first automation's is the home's.
    const own = readConfig('kraftverk: 4\nautomations:\n  a:\n    name: A\n    clock: Europe/London\n    do: []\n');
    expect(own.problems).toEqual([]);
    expect(own.document!.homes.home!.timeZone).toBe('Europe/London');
    expect(own.document!.automations.a!.clock).toBe('Europe/London');
    // And an automation says the home it is for, by its key.
    const cabin = readConfig(readFileSync(fixture(10), 'utf8')).document!;
    expect(cabin.homes.cabin!.type).toBe('cabin');
    expect(cabin.automations['start-charging']!.home).toBe('home');
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

  test('version 9 says how long where a device has been is kept — never where it was — and nothing older says it', () => {
    const read = readConfig(readFileSync(fixture(9), 'utf8'));
    expect(read.document!.devices['pocket-phone']!.track).toBe(30);
    expect(writeConfig(read.document!)).toContain('track: 30 days');
    expect(readConfig(readFileSync(fixture(8), 'utf8')).document!.devices['garage-station']!.track).toBeNull();
    const day = readConfig('kraftverk: 9\ndevices:\n  phone:\n    type: acme.phone\n    name: Phone\n    track: 1 day\n');
    expect(day.document!.devices.phone!.track).toBe(1);
    expect(writeConfig(day.document!)).toContain('track: 1 day\n');
    expect(readConfig('kraftverk: 9\ndevices:\n  phone:\n    type: acme.phone\n    name: Phone\n    track: forever\n').problems.map((problem) => problem.message)).toEqual([
      '"track" is how long where it has been is kept: "30 days", from 1 day to 366',
    ]);
  });
});

describe("an integration's own migrations", () => {
  /** An integration whose way "cloud" became "account" in version 6: it finds its entries by the installed types reached through its account. */
  const renamed = {
    from: 5,
    says: 'A scooter reached "cloud" is reached through its account',
    migrate(document: Readonly<Record<string, unknown>>, installed: readonly { id: string; methods: readonly { id: string; through: readonly string[] }[] }[]) {
      const mine = new Set(installed.filter((type) => type.methods.some((method) => method.through.includes('acme.account'))).map((type) => type.id));
      const devices = Object.fromEntries(
        Object.entries((document.devices ?? {}) as Record<string, { type: string; connect?: { via: string }[] }>).map(([key, entry]) => [
          key,
          mine.has(entry.type) ? { ...entry, connect: (entry.connect ?? []).map((way) => (way.via === 'cloud' ? { ...way, via: 'account' } : way)) } : entry,
        ])
      );
      return { ...document, devices };
    },
  };
  const installed = [{ id: 'acme.scooter', methods: [{ id: 'account', through: ['acme.account'] }] }];
  const file = (version: number) => `kraftverk: ${version}\ndevices:\n  scooter:\n    type: acme.scooter\n    name: Scooter\n    connect:\n      - via: cloud\n        address: S-1\n`;

  test("run after the core's own, from their version, for a file written before it — and not for one written after", () => {
    const old = readConfig(file(4), undefined, { migrations: { migrations: [renamed], installed } });
    expect(old.problems).toEqual([]);
    expect(old.document!.devices.scooter!.connect[0]!.via).toBe('account');
    expect(readConfig(file(6), undefined, { migrations: { migrations: [renamed], installed } }).document!.devices.scooter!.connect[0]!.via).toBe('cloud');
    // Without them, a file is read as its shape says.
    expect(readConfig(file(4)).document!.devices.scooter!.connect[0]!.via).toBe('cloud');
  });
});
