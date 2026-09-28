/**
 * Rehearses the pending migrations against a copy of a real database
 * (docs/ARCHITECTURE.md §4.5), on the owner's machine: the data never leaves it.
 *
 *   npm run db:rehearse -- path/to/kraftverk.db
 *
 * The file named is only ever read. A consistent copy of it (`VACUUM INTO`) is
 * migrated in a temporary folder, and the report says what would change: every
 * table's rows before and after, every device's history before and after, what
 * each device became, and anything the migration left a note about. It ends
 * with SQLite's own integrity and foreign-key checks, and fails if history was
 * lost that the migration did not say it would remove.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Database } from 'bun:sqlite';

import { DeviceTypeRegistry } from '../devices/types.ts';
import { migrate, MIGRATIONS } from './db.ts';

const source = process.argv[2];
if (!source) {
  console.error('Usage: npm run db:rehearse -- <a copy of the database>');
  process.exit(1);
}

type Counts = Map<string, number>;

const tables = (handle: Database): Counts =>
  new Map(
    handle
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map(({ name }) => [name, handle.query<{ n: number }, []>(`SELECT COUNT(*) n FROM "${name}"`).get()!.n])
  );

const history = (handle: Database): Counts =>
  new Map(handle.query<{ device_id: string; n: number }, []>('SELECT device_id, COUNT(*) n FROM sample GROUP BY device_id').all().map((row) => [row.device_id, row.n]));

const applied = (handle: Database): number[] => {
  const exists = handle.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration'").get();
  return exists ? handle.query<{ id: number }, []>('SELECT id FROM migration ORDER BY id').all().map((row) => row.id) : [];
};

const dir = mkdtempSync(join(tmpdir(), 'kraftverk-rehearsal-'));
const copy = join(dir, 'kraftverk.db');
let failed = false;

try {
  const original = new Database(resolve(source), { readonly: true });
  original.query('VACUUM INTO ?').run(copy);
  original.close();

  const handle = new Database(copy);
  handle.exec('PRAGMA foreign_keys = ON');

  const before = { applied: applied(handle), tables: tables(handle), history: history(handle) };
  const pending = MIGRATIONS.filter((migration) => !before.applied.includes(migration.id)).map((migration) => migration.id);
  console.log(`Rehearsing on a copy of ${source}`);
  console.log(`  applied: ${before.applied.join(', ') || 'none'}; pending: ${pending.join(', ') || 'none'}\n`);
  if (!pending.length) console.log('Nothing to rehearse: this database is up to date.\n');

  migrate(handle, copy);

  const after = { tables: tables(handle), history: history(handle) };

  console.log('Rows per table (before → after):');
  for (const name of [...new Set([...before.tables.keys(), ...after.tables.keys()])].sort()) {
    const was = before.tables.get(name);
    const is = after.tables.get(name);
    console.log(`  ${name.padEnd(20)} ${was === undefined ? '—' : was} → ${is === undefined ? 'dropped' : is}`);
  }

  const types = new DeviceTypeRegistry();
  await types.discover();
  const devices = handle
    .query<{ id: string; name: string; type_id: string | null; identity: string | null; removed_at: string | null }, []>(
      'SELECT id, name, type_id, identity, removed_at FROM device ORDER BY added_at'
    )
    .all();
  const connections = handle.query<{ method: string; transport: string; address: string; held_by: string | null }, [string]>(
    'SELECT method, transport, address, held_by FROM device_connection WHERE device_id = ? ORDER BY priority'
  );
  const links = handle.query<{ kind: string; target: string }, [string]>(
    'SELECT kind, (SELECT name FROM device WHERE id = target_id) target FROM device_link WHERE source_id = ?'
  );
  console.log('\nDevices after:');
  for (const device of devices) {
    const installed = device.type_id ? types.get(device.type_id) : null;
    const reached = connections.all(device.id).map((row) => `${row.method} (${row.transport}, ${row.address}${row.held_by ? `, held by ${row.held_by}` : ''})`);
    const feeds = links.all(device.id).map((row) => `${row.kind} ${row.target}`);
    console.log(`  ${device.name} [${device.id}]`);
    console.log(`    ${device.type_id ?? 'no type'}${installed ? '' : ' — NOT INSTALLED here'}; identity ${device.identity ?? 'not known yet'}${device.removed_at ? '; removed' : ''}`);
    console.log(`    reached by: ${reached.join('; ') || 'nothing yet'}${feeds.length ? `; ${feeds.join('; ')}` : ''}`);
    console.log(`    history: ${before.history.get(device.id) ?? 0} → ${after.history.get(device.id) ?? 0} samples`);
  }

  // History the migration removed without saying so is the one failure that matters.
  const said = new Set(
    handle.query<{ resource: string }, []>("SELECT resource FROM audit WHERE kind = 'device.removed' AND resource IS NOT NULL").all().map((row) => row.resource)
  );
  const lost = [...before.history].filter(([id, n]) => (after.history.get(id) ?? 0) < n && !said.has(id));
  const notes = handle
    .query<{ at: string; kind: string; summary: string }, []>("SELECT at, kind, summary FROM audit WHERE actor LIKE 'migration%' ORDER BY rowid")
    .all();
  if (notes.length) {
    console.log('\nWhat the migrations said:');
    for (const note of notes) console.log(`  ${note.kind}: ${note.summary}`);
  }

  const integrity = handle.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all().map((row) => row.integrity_check);
  const foreign = handle.query('PRAGMA foreign_key_check').all();
  console.log(`\nIntegrity: ${integrity.join('; ')}. Foreign keys: ${foreign.length ? `${foreign.length} broken` : 'ok'}.`);
  if (lost.length) console.log(`HISTORY LOST without a note: ${lost.map(([id, n]) => `${id} (${n} → ${after.history.get(id) ?? 0})`).join(', ')}`);

  failed = lost.length > 0 || foreign.length > 0 || integrity.join() !== 'ok';
  console.log(failed ? '\nThe rehearsal FAILED: do not deploy this migration against that database.' : '\nThe rehearsal passed. The original was not touched.');
  handle.close();
} catch (error) {
  console.error(`\nThe rehearsal FAILED: ${(error as Error).message}`);
  failed = true;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
