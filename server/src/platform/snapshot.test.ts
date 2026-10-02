import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AutomationLibrary } from '@kraftverk/automation-engine';
import { readConfig } from '@kraftverk/home-file';
import { changesConfiguration, Configuration, DeviceTypeRegistry, openKept, ProtocolRegistry, type ConfigurationDeps } from '@kraftverk/hub';
import { LAMP, lampProtocol, lampType } from '@kraftverk/hub/testing';
import { AutomationStore, ConnectionStore, DeviceCatalog, LinkStore } from '@kraftverk/store';

import { audit, closeDb, db, onAudit, policyValues, setPolicyValue } from './database.ts';
import { serverSealing } from './sealing.ts';
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
let catalog: DeviceCatalog;
let connections: ConnectionStore;
const file = join(dir, 'config', 'kraftverk.yaml');

beforeAll(() => {
  process.env.KRAFTVERK_DB = join(dir, 'test.db');
  closeDb();
  const types = new DeviceTypeRegistry();
  types.install(lampType);
  const protocols = new ProtocolRegistry();
  protocols.install(lampProtocol);
  catalog = new DeviceCatalog(db());
  connections = new ConnectionStore(db(), serverSecrets);
  const automations = new AutomationStore(db());
  // Writing the file asks only what the home has: nothing here is imported, run or synced.
  const unused = { sessions: { sync: async () => {} }, engine: { reset: () => {}, poke: () => {}, forget: () => {} }, transports: { definition: () => null } } as unknown as Pick<ConfigurationDeps, 'sessions' | 'engine' | 'transports'>;
  const configuration = new Configuration({
    db: db(),
    catalog,
    connections,
    links: new LinkStore(db()),
    automations,
    types,
    protocols,
    library: new AutomationLibrary([]),
    checked: () => ({ problems: [], roles: {}, starts: {} }),
    policy: { values: policyValues, set: setPolicyValue },
    sealing: serverSealing,
    kept: serverSecrets,
    record: audit,
    ...unused,
  });
  snapshot = new ConfigSnapshot(configuration, file);
});

afterAll(async () => {
  await snapshot.stop();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('the configuration kept beside the database', () => {
  test('written whole: each device, how it is reached, its secret kept — and not again when nothing changed', async () => {
    const lamp = catalog.add({ typeId: 'test.lamp', name: 'Hall lamp', description: LAMP });
    const way = connections.add({ deviceId: lamp.id, method: 'bus', transport: 'bus', heldBy: null, address: 'lamp-1' });
    connections.setSecrets(way.id, { pin: 'pin-from-a-test' });
    expect(await snapshot.write()).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n')[0]).toBe('# Kept by kraftverk beside its database, and written again after every change to it.');
    const { document, problems } = readConfig(text);
    expect(problems).toEqual([]);
    expect(document!.devices['hall-lamp']).toMatchObject({ type: 'test.lamp', connect: [{ via: 'bus', address: 'lamp-1', secrets: { pin: { secret: 'hall-lamp.pin' } } }] });
    // Kept as the database keeps it — sealed with the server's key where it has one — and opened again by this server.
    const kept = document!.secrets['hall-lamp.pin']!;
    expect(kept.startsWith('sealed:server:') === Boolean(process.env.KRAFTVERK_SECRET_KEY)).toBe(true);
    expect(openKept(serverSecrets, kept)).toBe('pin-from-a-test');
    expect(await snapshot.write()).toBe(false);
  });

  test('a change on the timeline writes it again, a moment later — the one before it kept', async () => {
    const stop = onAudit((entry) => {
      if (changesConfiguration(entry.kind)) snapshot.schedule();
    });
    catalog.add({ typeId: 'test.lamp', name: 'Porch lamp', description: LAMP });
    audit({ at: new Date().toISOString(), kind: 'device.added', actor: 'test', summary: 'Added "Porch lamp"' });
    // A reading, a run: not a change to the configuration.
    audit({ at: new Date().toISOString(), kind: 'automation.started', actor: 'test', summary: 'Started' });
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
    const restoring = new ConfigSnapshot(
      {
        kept: async () => '',
        restore: async (text, from) => {
          heard.push(text);
          return { at: new Date().toISOString(), from, applied: null, problems: [] };
        },
      },
      kept
    );
    const restored = (await restoring.restore())!;
    expect(heard).toEqual(['kraftverk: 1\n# the one restored from\n']);
    expect(restored.from.startsWith(join(folder, 'kraftverk.before-'))).toBe(true);
    expect(restoring.restoredCopy()).toBe(heard[0]!);
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
