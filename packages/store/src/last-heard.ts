import type { SqlDatabase } from './database.ts';

/*
  What a server last said, as an app holding for it heard it
  (docs/PLAN-SHARED-CORE.md, phase 6): each answer the screens read — the
  devices, the automations, the home's values — kept by what was asked, as
  it was answered, so the app can show the server's home while the server
  cannot be reached. Kept in the app's own database; replaced by each
  answer after.
*/

export type Heard<T> = { body: T; heardAt: string };

export class LastHeard {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** What was just answered to `what`, kept in place of what was before. */
  keep(what: string, body: unknown, at = new Date().toISOString()): void {
    this.#db
      .query('INSERT INTO last_heard (what, body, heard_at) VALUES (?, ?, ?) ON CONFLICT (what) DO UPDATE SET body = excluded.body, heard_at = excluded.heard_at')
      .run(what, JSON.stringify(body), at);
  }

  /** What was last answered to `what`, and when; null when it never was. */
  get<T>(what: string): Heard<T> | null {
    const row = this.#db.query<{ body: string; heard_at: string }, [string]>('SELECT body, heard_at FROM last_heard WHERE what = ?').get(what);
    return row ? { body: JSON.parse(row.body) as T, heardAt: row.heard_at } : null;
  }
}
