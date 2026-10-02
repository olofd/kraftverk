import type { SqlDatabase } from './database.ts';

/*
  What a node holding connections for the home's master owes it, kept in
  the node's own database so a restart loses none of it (docs/PLAN-SHARED-CORE.md,
  phase 6): readings, events, timeline entries and what a session kept,
  each queued as it happens and taken in order when the master answers.
*/

export type SendKind = 'readings' | 'event' | 'audit' | 'store';

/** One thing owed: what it is, the device it is about, and what to send. */
export type Owed<T = unknown> = { id: number; kind: SendKind; deviceId: string | null; body: T; queuedAt: string };

type Row = { id: number; kind: SendKind; device_id: string | null; body: string; queued_at: string };

export class SendQueue {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  add(kind: SendKind, deviceId: string | null, body: unknown, at = new Date().toISOString()): void {
    this.#db.query('INSERT INTO send_queue (kind, device_id, body, queued_at) VALUES (?, ?, ?, ?)').run(kind, deviceId, JSON.stringify(body), at);
  }

  /** The oldest owed, up to `limit`, in the order they were owed. */
  next(limit: number): Owed[] {
    return this.#db
      .query<Row, [number]>('SELECT * FROM send_queue ORDER BY id LIMIT ?')
      .all(limit)
      .map((row) => ({ id: row.id, kind: row.kind, deviceId: row.device_id, body: JSON.parse(row.body) as unknown, queuedAt: row.queued_at }));
  }

  /** Sent, or refused for good: no longer owed. */
  done(ids: readonly number[]): void {
    if (!ids.length) return;
    this.#db.transaction(() => {
      const remove = this.#db.query('DELETE FROM send_queue WHERE id = ?');
      for (const id of ids) remove.run(id);
    })();
  }

  count(): number {
    return this.#db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM send_queue').get()?.n ?? 0;
  }

  /** Keeps at most `max` of a kind, the newest: a master away for weeks does not fill a phone that follows it. */
  trim(kind: SendKind, max: number): void {
    this.#db.query('DELETE FROM send_queue WHERE kind = ? AND id NOT IN (SELECT id FROM send_queue WHERE kind = ? ORDER BY id DESC LIMIT ?)').run(kind, kind, max);
  }
}
