import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readConfig } from '@kraftverk/home-file';

import { AutomationStore, DeviceCatalog, ConnectionStore, LinkStore } from '@kraftverk/store';
import { LAMP, lampProtocol, lampType } from '../devices/testing.ts';
import { DeviceTypeRegistry } from '../devices/types.ts';
import { audit, closeDb, db } from '../platform/database.ts';
import { ProtocolRegistry } from '../runtime/protocols.ts';
import { openKept } from './seal.ts';
import { ConfigSnapshot } from './snapshot.ts';
import { serverSecrets } from '../platform/secrets.ts';

/*
  The configuration kept beside the database: written whole, its secrets kept
  as the database keeps them, written again after a change — the one before
  it kept — and not again when nothing changed.
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
  snapshot = new ConfigSnapshot({ catalog, connections, links: new LinkStore(db()), automations: new AutomationStore(db()), types, protocols }, file);
});

afterAll(() => {
  snapshot.stop();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('the configuration kept beside the database', () => {
  test('written whole: each device, how it is reached, its secret kept — and not again when nothing changed', () => {
    const lamp = catalog.add({ typeId: 'test.lamp', name: 'Hall lamp', description: LAMP });
    const way = connections.add({ deviceId: lamp.id, method: 'bus', transport: 'bus', heldBy: null, address: 'lamp-1' });
    connections.setSecrets(way.id, { pin: 'pin-from-a-test' });
    expect(snapshot.write()).toBe(true);
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n')[0]).toBe('# Kept by kraftverk beside its database, and written again after every change to it.');
    const { document, problems } = readConfig(text);
    expect(problems).toEqual([]);
    expect(document!.devices['hall-lamp']).toMatchObject({ type: 'test.lamp', connect: [{ via: 'bus', address: 'lamp-1', secrets: { pin: { secret: 'hall-lamp.pin' } } }] });
    // Kept as the database keeps it — sealed with the server's key where it has one — and opened again by this server.
    const kept = document!.secrets['hall-lamp.pin']!;
    expect(kept.startsWith('sealed:server:') === Boolean(process.env.KRAFTVERK_SECRET_KEY)).toBe(true);
    expect(openKept(kept)).toBe('pin-from-a-test');
    expect(snapshot.write()).toBe(false);
  });

  test('a change on the timeline writes it again, a moment later — the one before it kept', async () => {
    snapshot.start();
    catalog.add({ typeId: 'test.lamp', name: 'Porch lamp', description: LAMP });
    audit({ at: new Date().toISOString(), kind: 'device.added', actor: 'test', summary: 'Added "Porch lamp"' });
    // A reading, a run: not a change to the configuration.
    audit({ at: new Date().toISOString(), kind: 'automation.started', actor: 'test', summary: 'Started' });
    snapshot.stop();
    expect(readFileSync(file, 'utf8')).toContain('porch-lamp:');
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(readFileSync(`${file}.1`, 'utf8')).not.toContain('porch-lamp:');
  });
});
