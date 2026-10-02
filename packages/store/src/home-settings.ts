import type { SqlDatabase } from './database.ts';

/**
 * What this node has settled for the home it keeps, by name (`home_setting`):
 * its policy values, and whether its own home has moved to a server or a
 * server's copy has been brought in. Each name is one the schema lists:
 * nothing else is kept here.
 */
export type HomeSettingKey = 'policy.values' | 'home.moved' | 'home.kept';

export class HomeSettings {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** What was settled, or null if it never has been. */
  get(key: HomeSettingKey): string | null {
    return this.#db.query<{ value: string }, [string]>('SELECT value FROM home_setting WHERE key = ?').get(key)?.value ?? null;
  }

  set(key: HomeSettingKey, value: string): void {
    this.#db
      .query<unknown, [string, string, string]>(
        `INSERT INTO home_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  }
}
