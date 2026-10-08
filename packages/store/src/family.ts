import { nodeId, type NodeId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';
import { newId } from '@kraftverk/device-sdk';

/**
 * The family this database is (docs/PLAN-WORLD-MODEL.md §8.1): one. What
 * every node and device here is part of; and its master — the node whose
 * database is the family's, the one that writes it. A node that follows the
 * family keeps it as the master's database has it.
 */

/** What a family calls itself on screen: the words only, never what it may do. */
export const FAMILY_KINDS = ['family', 'household', 'friends', 'other'] as const;
export type FamilyKind = (typeof FAMILY_KINDS)[number];

export type FamilyRecord = {
  id: string;
  /** What the people in it call it. */
  name: string;
  kind: FamilyKind;
  /** BCP 47: the language what is said to all of it is said in. */
  locale: string;
  /** The node whose database is the family's. */
  masterId: NodeId;
  createdAt: string;
};

type Row = { id: string; name: string; kind: FamilyKind; locale: string; master_id: string; created_at: string };

const toRecord = (row: Row): FamilyRecord => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  locale: row.locale,
  masterId: nodeId(row.master_id),
  createdAt: row.created_at,
});

export class FamilyStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** The family; null until there is one. */
  get(): FamilyRecord | null {
    const row = this.#db.query<Row, []>('SELECT * FROM family LIMIT 1').get();
    return row ? toRecord(row) : null;
  }

  /** The family, made the first time — its master the node that made it — and as it is after. */
  ensure(made: { name: string; masterId: NodeId; kind?: FamilyKind; locale?: string; id?: string }): FamilyRecord {
    const had = this.get();
    if (had) return had;
    const id = made.id ?? newId('f');
    this.#db.query('INSERT INTO family (id, name, kind, locale, master_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, made.name, made.kind ?? 'family', made.locale ?? 'en', made.masterId, new Date().toISOString());
    return this.get()!;
  }

  /** The person who founded it: said once, when the first person comes into a family a node made. */
  foundedBy(personId: string): void {
    this.#db.query('UPDATE family SET created_by = ? WHERE created_by IS NULL').run(personId);
  }

  /** What it is called, its kind, its language: what is given, the rest as it was. */
  update(changes: Partial<Pick<FamilyRecord, 'name' | 'kind' | 'locale'>>): FamilyRecord {
    const was = this.get()!;
    const next = { ...was, ...changes };
    this.#db.query('UPDATE family SET name = ?, kind = ?, locale = ? WHERE id = ?').run(next.name, next.kind, next.locale, was.id);
    return this.get()!;
  }

  /** The family as its master's database has it, kept in a node that follows it. */
  mirror(record: FamilyRecord): void {
    this.#db.transaction(() => {
      this.#db.query('DELETE FROM family WHERE id <> ?').run(record.id);
      this.#db
        .query(
          'INSERT INTO family (id, name, kind, locale, master_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, locale = excluded.locale, master_id = excluded.master_id'
        )
        .run(record.id, record.name, record.kind, record.locale, record.masterId, record.createdAt);
    })();
  }
}
