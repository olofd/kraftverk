import { nodeId, type NodeId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';
import { randomHex } from './ids.ts';

/**
 * The home this database keeps (docs/DATA-MODEL.md §3): one. What every
 * place, node and device here is part of; and its master — the node whose
 * database is the home's, the one that writes it. A node that follows the
 * home keeps it as the master's database has it.
 */

export type HomeRecord = {
  id: string;
  /** What the people in it call it. */
  name: string;
  /** The node whose database is the home's. */
  masterId: NodeId;
  createdAt: string;
};

type Row = { id: string; name: string; master_id: string; created_at: string };

const toRecord = (row: Row): HomeRecord => ({ id: row.id, name: row.name, masterId: nodeId(row.master_id), createdAt: row.created_at });

export class HomeStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** The home; null until there is one. */
  get(): HomeRecord | null {
    const row = this.#db.query<Row, []>('SELECT * FROM home LIMIT 1').get();
    return row ? toRecord(row) : null;
  }

  /** The home, made the first time — its master the node that made it — and as it is after. */
  ensure(made: { name: string; masterId: NodeId }): HomeRecord {
    const had = this.get();
    if (had) return had;
    const id = `h-${randomHex(6)}`;
    this.#db.query('INSERT INTO home (id, name, master_id, created_at) VALUES (?, ?, ?, ?)').run(id, made.name, made.masterId, new Date().toISOString());
    return this.get()!;
  }

  /** The home as its master's database has it, kept in a node that follows it. */
  mirror(record: HomeRecord): void {
    this.#db.transaction(() => {
      this.#db.query('DELETE FROM home WHERE id <> ?').run(record.id);
      this.#db
        .query('INSERT INTO home (id, name, master_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET name = excluded.name, master_id = excluded.master_id')
        .run(record.id, record.name, record.masterId, record.createdAt);
    })();
  }
}
