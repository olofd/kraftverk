import { newId, type Actor, type ActorKind, type ConfigField, type Value } from '@kraftverk/device-sdk';
import type { VariableKind } from '@kraftverk/automation';

import type { SqlDatabase } from './database.ts';

/**
 * A home's variables (docs/PLAN-VARIABLES-AND-TRIGGERS.md §2): each by its
 * key in its home, its kind and its field — and its value now, with who set
 * it and when. What a value must be to fit its field, and what is said when
 * it changes, is the hub's; here it is only kept.
 */

export type VariableRecord = {
  id: string;
  homeId: string;
  key: string;
  kind: VariableKind;
  field: ConfigField;
  position: number;
  createdAt: string;
  removedAt: string | null;
};

/** A variable's value now: what was set, when, by whom. None set: what it starts as is the hub's to say. */
export type VariableValueRecord = { value: Value; setAt: string; by: Actor };

type VariableRow = { id: string; home_id: string; key: string; kind: VariableKind; field: string; position: number; created_at: string; removed_at: string | null };
type ValueRow = { value: string; set_at: string; actor_kind: ActorKind; actor_id: string | null; actor_name: string };

const recordOf = (row: VariableRow): VariableRecord => ({
  id: row.id,
  homeId: row.home_id,
  key: row.key,
  kind: row.kind,
  field: JSON.parse(row.field) as ConfigField,
  position: row.position,
  createdAt: row.created_at,
  removedAt: row.removed_at,
});

/** What a variable is: its key, kind and field. */
type Declared = Pick<VariableRecord, 'key' | 'kind' | 'field'>;

export class VariableStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** A home's variables, in their order; with those let go, `removed`. */
  list(homeId: string, options: { removed?: boolean } = {}): VariableRecord[] {
    return this.#db
      .query<VariableRow, [string]>(`SELECT * FROM variable WHERE home_id = ? ${options.removed ? '' : 'AND removed_at IS NULL'} ORDER BY position, created_at`)
      .all(homeId)
      .map(recordOf);
  }

  get(id: string): VariableRecord | null {
    const row = this.#db.query<VariableRow, [string]>('SELECT * FROM variable WHERE id = ?').get(id);
    return row ? recordOf(row) : null;
  }

  /** A home's variable by its key, of those not let go. */
  byKey(homeId: string, key: string): VariableRecord | null {
    const row = this.#db.query<VariableRow, [string, string]>('SELECT * FROM variable WHERE home_id = ? AND key = ? AND removed_at IS NULL').get(homeId, key);
    return row ? recordOf(row) : null;
  }

  add(homeId: string, input: Declared, at: string, id = newId('v')): VariableRecord {
    const position = (this.#db.query<{ next: number }, [string]>('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM variable WHERE home_id = ?').get(homeId)?.next ?? 0) as number;
    this.#db.query('INSERT INTO variable (id, home_id, key, kind, field, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, homeId, input.key, input.kind, JSON.stringify(input.field), position, at);
    return this.get(id)!;
  }

  /** Its key, kind or field changed: a value it holds that no longer fits is the hub's to put right. */
  update(id: string, changes: Partial<Declared>): VariableRecord | null {
    const was = this.get(id);
    if (!was) return null;
    const next = { ...was, ...changes };
    this.#db.query('UPDATE variable SET key = ?, kind = ?, field = ? WHERE id = ?').run(next.key, next.kind, JSON.stringify(next.field), id);
    return this.get(id);
  }

  /** Let go: archived, its value gone with it, its key free again. */
  remove(id: string, at: string): VariableRecord | null {
    this.#db.query('UPDATE variable SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(at, id);
    this.#db.query('DELETE FROM variable_value WHERE variable_id = ?').run(id);
    return this.get(id);
  }

  /** Its value now, as set; null when none has been. */
  value(id: string): VariableValueRecord | null {
    const row = this.#db.query<ValueRow, [string]>('SELECT * FROM variable_value WHERE variable_id = ?').get(id);
    return row ? { value: JSON.parse(row.value) as Value, setAt: row.set_at, by: { kind: row.actor_kind, id: row.actor_id, name: row.actor_name } as Actor } : null;
  }

  /** Its value set, by someone, at a time. */
  set(id: string, value: Value, by: Actor, at: string): void {
    this.#db
      .query('INSERT INTO variable_value (variable_id, value, set_at, actor_kind, actor_id, actor_name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (variable_id) DO UPDATE SET value = excluded.value, set_at = excluded.set_at, actor_kind = excluded.actor_kind, actor_id = excluded.actor_id, actor_name = excluded.actor_name')
      .run(id, JSON.stringify(value), at, by.kind, 'id' in by ? (by.id ?? null) : null, by.name);
  }

  /** Back to what it starts as: no value set. */
  clear(id: string): void {
    this.#db.query('DELETE FROM variable_value WHERE variable_id = ?').run(id);
  }
}
