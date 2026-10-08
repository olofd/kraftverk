import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ImportPlan } from '@kraftverk/api-contract';
import { readConfig } from '@kraftverk/home-file';
import { changesConfiguration, createHub, installedFrom, openKept, passphraseSealing, type Hub } from '@kraftverk/hub';
import { LAMP, lampType, MACHINE_NODE, testIntegration } from '@kraftverk/hub/testing';
import { AuditLog, type SecretsAtRest } from '@kraftverk/store';

import { openDatabase } from './database.ts';
import { serverSecrets } from './secrets.ts';
import { ConfigSnapshot } from './snapshot.ts';
import { actor } from '@kraftverk/device-sdk';

/*
  The configuration kept beside the database, as a file on the server's
  disk: written whole, its secrets kept as the database keeps them, written
  again after a change — the one before it kept — and not again when nothing
  changed.
*/

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-snapshot-'));
let snapshot: ConfigSnapshot;
let hub: Hub;
let audit: AuditLog;
/** Sealed with a key, as a server given `KRAFTVERK_SECRET_KEY` seals them. */
const secrets: SecretsAtRest = serverSecrets('a key for these tests only');
const file = join(dir, 'config', 'kraftverk.yaml');

beforeAll(() => {
  const { database } = openDatabase(join(dir, 'test.db'));
  audit = new AuditLog(database);
  // A home as the server makes one — not started: writing the file asks only what it has.
  hub = createHub({
    database,
    audit,
    secrets,
    sealing: passphraseSealing,
    installed: installedFrom({ integrations: [testIntegration({ type: lampType })], transports: [] }, { platform: 'system', context: { env: {}, log: () => {}, audit: () => {} } }),
    node: MACHINE_NODE,
    readOnly: () => true,
    http: () => Promise.reject(new Error('no network in these tests')),
  });
  snapshot = new ConfigSnapshot(hub.configuration, file);
});

afterAll(async () => {
  await snapshot.stop();
  hub.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the configuration kept beside the database', () => {
  test('written whole: each device, how it is reached, its secret kept — and not again when nothing changed', async () => {
    const lamp = hub.catalog.add({ typeId: 'test.lamp', name: 'Hall lamp', description: LAMP });
    const way = hub.connections.add({ deviceId: lamp.id, method: 'bus', transport: 'bus', heldBy: MACHINE_NODE.id, address: 'lamp-1' });
    hub.connections.setSecrets(way.id, { pin: 'pin-from-a-test' });
    expect(await snapshot.write()).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n')[0]).toBe('# Kept by kraftverk beside its database, and written again after every change to it.');
    const { document, problems } = readConfig(text);
    expect(problems).toEqual([]);
    expect(document!.devices['hall-lamp']).toMatchObject({ type: 'test.lamp', connect: [{ via: 'bus', address: 'lamp-1', secrets: { pin: { secret: 'hall-lamp.pin' } } }] });
    // Kept as the database keeps it — sealed with the server's key where it has one — and opened again by this server.
    const kept = document!.secrets['hall-lamp.pin']!;
    expect(kept.startsWith('sealed:server:')).toBe(true);
    expect(openKept(secrets, kept)).toBe('pin-from-a-test');
    expect(await snapshot.write()).toBe(false);
  });

  test('a change on the timeline writes it again, a moment later — the one before it kept', async () => {
    const stop = audit.onRecord((entry) => {
      if (changesConfiguration(entry.kind)) snapshot.schedule();
    });
    hub.catalog.add({ typeId: 'test.lamp', name: 'Porch lamp', description: LAMP });
    audit.record({ at: new Date().toISOString(), kind: 'device.added', actor: actor('person', 'test'), summary: 'Added "Porch lamp"' });
    // A reading, a run: not a change to the configuration.
    audit.record({ at: new Date().toISOString(), kind: 'automation.started', actor: actor('person', 'test'), summary: 'Started' });
    stop();
    await snapshot.stop();
    expect(readFileSync(file, 'utf8')).toContain('porch-lamp:');
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(`${file}.1`, 'utf8')).not.toContain('porch-lamp:');
  });

  test('a home that does not check against what is installed is not written: the copy before it is left as it is', async () => {
    const before = readFileSync(file, 'utf8');
    // A way its type no longer has: left in the database, as by an update that moved it without carrying it over.
    const attic = hub.catalog.add({ typeId: 'test.lamp', name: 'Attic lamp', description: LAMP });
    const gone = hub.connections.add({ deviceId: attic.id, method: 'gone', transport: 'bus', heldBy: MACHINE_NODE.id, address: 'lamp-9' });
    await expect(snapshot.write()).rejects.toThrow(/does not check, so the copy kept before is left as it is: devices\.attic-lamp\.connect\.0\.via/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    hub.connections.remove(gone.id);
    hub.catalog.remove(attic.id);
  });

  test('the pictures it names are kept beside it, let go when it no longer names them, and put back before a restore', async () => {
    const folder = join(dir, 'pictures');
    mkdirSync(folder, { recursive: true });
    const kept = join(folder, 'kraftverk.yaml');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    let named = [{ id: 'cd'.repeat(32), type: 'image/png' as const, width: 4, height: 3, data: png }];
    let text = 'kraftverk: 10\n# one\n';
    const put: { type: string; width: number; height: number; data: Uint8Array }[][] = [];
    const snapshot = new ConfigSnapshot(
      {
        kept: async () => text,
        pictures: () => named,
        keepPictures: (pictures) => void put.push([...pictures]),
        restore: async (_, from) => ({ at: new Date().toISOString(), from, applied: null, problems: [] }),
        plan: async () => {
          throw new Error('not asked');
        },
      },
      kept
    );
    await snapshot.write();
    expect(readdirSync(join(folder, 'media'))).toEqual([`${'cd'.repeat(32)}.4x3.png`]);
    // Put back, as it was, before a restore reads the file that names it.
    await snapshot.restore();
    expect(put).toEqual([[{ type: 'image/png', width: 4, height: 3, data: png }]]);
    // Named no more: let go.
    named = [];
    text = 'kraftverk: 10\n# two\n';
    await snapshot.write();
    expect(readdirSync(join(folder, 'media'))).toEqual([]);
  });

  test('a restore is made from a copy set aside first, of which the last five are kept', async () => {
    const folder = join(dir, 'copies');
    mkdirSync(folder, { recursive: true });
    const kept = join(folder, 'kraftverk.yaml');
    for (let n = 0; n < 7; n++) writeFileSync(join(folder, `kraftverk.before-2026-01-0${n + 1}T00-00-00Z.yaml`), 'kraftverk: 4\n');
    writeFileSync(kept, 'kraftverk: 4\n# the one restored from\n');
    const heard: string[] = [];
    const planned: string[] = [];
    const restoring = new ConfigSnapshot(
      {
        kept: async () => '',
        pictures: () => [],
        keepPictures: () => {},
        restore: async (text, from) => {
          heard.push(text);
          return { at: new Date().toISOString(), from, applied: null, problems: [] };
        },
        plan: async (text): Promise<ImportPlan> => {
          planned.push(text);
          return { id: null, from: 1, problems: [], devices: [], links: [], automations: [], family: [], people: [], homes: [], labels: [], policy: [], needs: { passphrase: null, secrets: [], rebind: [], confirm: [] }, notes: [] };
        },
      },
      kept
    );
    const restored = (await restoring.restore())!;
    expect(heard).toEqual(['kraftverk: 4\n# the one restored from\n']);
    expect(restored.from.startsWith(join(folder, 'kraftverk.before-'))).toBe(true);
    // What it could not do alone is planned again from that copy.
    await restoring.planAgain('merge', actor('person', 'olof'));
    expect(planned).toEqual(heard);
    const copies = readdirSync(folder).filter((name) => name.startsWith('kraftverk.before-')).sort();
    expect(copies.length).toBe(5);
    expect(copies[0]).toBe('kraftverk.before-2026-01-04T00-00-00Z.yaml');
  });

  test('a restore that fails is tried again at the next start, and the file is not written over until it is done', async () => {
    const folder = join(dir, 'unfinished');
    mkdirSync(folder, { recursive: true });
    const kept = join(folder, 'kraftverk.yaml');
    const home = 'kraftverk: 4\n# the home to restore\n';
    writeFileSync(kept, home);
    let fails = true;
    let writes = 0;
    const snapshotOf = () =>
      new ConfigSnapshot(
        {
          kept: async () => {
            writes += 1;
            return 'kraftverk: 4\n# an empty home\n';
          },
          pictures: () => [],
          keepPictures: () => {},
          restore: async (_, from) => {
            if (fails) throw new Error('A value this version does not know');
            return { at: new Date().toISOString(), from, applied: { devices: { added: ['lamp'], restored: [], changed: [], removed: [] }, automations: { added: [], changed: [], removed: [] }, links: { added: 0, removed: 0 }, family: false, people: { added: [], changed: [] }, homes: { added: [], changed: [] }, labels: { added: [], changed: [] }, policy: [], notes: [] }, problems: [] };
          },
          plan: async () => {
            throw new Error('not asked');
          },
        },
        kept
      );
    // A fresh database: the restore fails. Nothing is written over the file.
    await snapshotOf().begin(true);
    expect(readFileSync(kept, 'utf8')).toBe(home);
    expect(writes).toBe(0);
    // The next start — the database no longer fresh — tries it again; done, the file is written as the home is now.
    fails = false;
    await snapshotOf().begin(false);
    expect(writes).toBe(1);
    expect(readFileSync(kept, 'utf8')).toBe('kraftverk: 4\n# an empty home\n');
    // Finished: the start after that does not restore again.
    fails = true;
    await snapshotOf().begin(false);
    expect(writes).toBe(2);
  });
});
