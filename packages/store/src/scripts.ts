import { KEY, keyFrom, newId, type Actor, type ActorKind } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * A family's scripts (docs/PLAN-SCRIPTS.md §4): each by its key, its
 * source as written, and who last changed it. What a script compiles to and
 * what it declares are the hub's to read from the source, never kept here.
 */

export type ScriptRecord = {
  id: string;
  key: string;
  name: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: Actor;
};

type ScriptRow = { id: string; key: string; name: string; source: string; created_at: string; updated_at: string; updated_by_kind: ActorKind; updated_by_id: string | null; updated_by_name: string };

const recordOf = (row: ScriptRow): ScriptRecord => ({
  id: row.id,
  key: row.key,
  name: row.name,
  source: row.source,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  updatedBy: { kind: row.updated_by_kind, id: row.updated_by_id, name: row.updated_by_name },
});

export class ScriptStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** Every script, by name. */
  list(): ScriptRecord[] {
    return this.#db.query<ScriptRow, []>('SELECT * FROM script ORDER BY name COLLATE NOCASE').all().map(recordOf);
  }

  get(id: string): ScriptRecord | null {
    const row = this.#db.query<ScriptRow, [string]>('SELECT * FROM script WHERE id = ?').get(id);
    return row ? recordOf(row) : null;
  }

  byKey(key: string): ScriptRecord | null {
    const row = this.#db.query<ScriptRow, [string]>('SELECT * FROM script WHERE key = ?').get(key);
    return row ? recordOf(row) : null;
  }

  /** Whether no script but `except` is known by a key. */
  keyFree(key: string, except?: string): boolean {
    const holder = this.byKey(key);
    return !holder || holder.id === except;
  }

  /** A script kept, by `by`: its key as given, or made from its name. */
  add(input: { key?: string; name: string; source: string }, by: Actor, at: string): ScriptRecord {
    if (input.key !== undefined && (!KEY.test(input.key) || !this.keyFree(input.key))) throw new Error(`"${input.key}" is not a free key`);
    const key = input.key ?? keyFrom(input.name, (taken) => this.byKey(taken) !== null, 'script');
    const id = newId('sc');
    this.#db
      .query('INSERT INTO script (id, key, name, source, created_at, updated_at, updated_by_kind, updated_by_id, updated_by_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, key, input.name, input.source, at, at, by.kind, by.id, by.name);
    return this.get(id)!;
  }

  /** What is given of a script changed, by `by`; null when there is no such script. */
  update(id: string, changes: { key?: string; name?: string; source?: string }, by: Actor, at: string): ScriptRecord | null {
    const was = this.get(id);
    if (!was) return null;
    if (changes.key !== undefined && (!KEY.test(changes.key) || !this.keyFree(changes.key, id))) throw new Error(`"${changes.key}" is not a free key`);
    this.#db
      .query('UPDATE script SET key = ?, name = ?, source = ?, updated_at = ?, updated_by_kind = ?, updated_by_id = ?, updated_by_name = ? WHERE id = ?')
      .run(changes.key ?? was.key, changes.name ?? was.name, changes.source ?? was.source, at, by.kind, by.id, by.name, id);
    return this.get(id);
  }

  /** Gone; whether there was one. */
  remove(id: string): boolean {
    return this.#db.query('DELETE FROM script WHERE id = ?').run(id).changes > 0;
  }
}
