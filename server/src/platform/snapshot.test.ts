import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ImportPlan } from '@kraftverk/api-contract';
import { readConfig } from '@kraftverk/home-file';
import { changesConfiguration, createHub, DeviceTypeRegistry, installedFrom, openKept, passphraseSealing, ProtocolRegistry, type Hub } from '@kraftverk/hub';
import { LAMP, lampProtocol, lampType, MACHINE_NODE } from '@kraftverk/hub/testing';
import { AuditLog, type SecretsAtRest } from '@kraftverk/store';

import { openDatabase } from './database.ts';
import { serverSecrets } from './secrets.ts';
import { ConfigSnapshot } from './snapshot.ts';

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
  const types = new DeviceTypeRegistry();
  types.install(lampType);
  const protocols = new ProtocolRegistry();
  protocols.install(lampProtocol);
  // A home as the server makes one — not started: writing the file asks only what it has.
  hub = createHub({
    database,
    audit,
    secrets,
    sealing: passphraseSealing,
    installed: installedFrom({ types: [{ type: lampType }], protocols: [lampProtocol], transports: [] }, { platform: 'system', context: { env: {}, log: () => {}, audit: () => {} } }),
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
    audit.record({ at: new Date().toISOString(), kind: 'device.added', actor: 'test', summary: 'Added "Porch lamp"' });
    // A reading, a run: not a change to the configuration.
    audit.record({ at: new Date().toISOString(), kind: 'automation.started', actor: 'test', summary: 'Started' });
    stop();
    await snapshot.stop();
    expect(readFileSync(file, 'utf8')).toContain('porch-lamp:');
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(`${file}.1`, 'utf8')).not.toContain('porch-lamp:');
  });

  test('a restore is made from a copy set aside first, of which the last five are kept', async () => {
    const folder = join(dir, 'copies');
    mkdirSync(folder, { recursive: true });
    const kept = join(folder, 'kraftverk.yaml');
    for (let n = 0; n < 7; n++) writeFileSync(join(folder, `kraftverk.before-2026-01-0${n + 1}T00-00-00Z.yaml`), 'kraftverk: 1\n');
    writeFileSync(kept, 'kraftverk: 1\n# the one restored from\n');
    const heard: string[] = [];
    const planned: string[] = [];
    const restoring = new ConfigSnapshot(
      {
        kept: async () => '',
        restore: async (text, from) => {
          heard.push(text);
          return { at: new Date().toISOString(), from, applied: null, problems: [] };
        },
        plan: async (text) => {
          planned.push(text);
          return {} as ImportPlan;
        },
      },
      kept
    );
    const restored = (await restoring.restore())!;
    expect(heard).toEqual(['kraftverk: 1\n# the one restored from\n']);
    expect(restored.from.startsWith(join(folder, 'kraftverk.before-'))).toBe(true);
    // What it could not do alone is planned again from that copy.
    await restoring.planAgain('merge', 'olof');
    expect(planned).toEqual(heard);
    const copies = readdirSync(folder).filter((name) => name.startsWith('kraftverk.before-')).sort();
    expect(copies.length).toBe(5);
    expect(copies[0]).toBe('kraftverk.before-2026-01-04T00-00-00Z.yaml');
  });

  test('a run or a reading on the timeline is no change to it; a device or an automation changed is', () => {
    expect(changesConfiguration('automation.started')).toBe(false);
    expect(changesConfiguration('device.control')).toBe(false);
    expect(changesConfiguration('device.added')).toBe(true);
    expect(changesConfiguration('automation.armed')).toBe(true);
  });
});
