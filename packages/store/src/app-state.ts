import type { SqlDatabase } from './database.ts';

/** Decisions a home has made, by name: kept until changed. */
export class AppState {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** A decision already made, or null if it never has been. */
  get(key: string): string | null {
    return this.#db.query<{ value: string }, [string]>('SELECT value FROM app_state WHERE key = ?').get(key)?.value ?? null;
  }

  set(key: string, value: string): void {
    this.#db
      .query<unknown, [string, string, string]>(
        `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  }
}
