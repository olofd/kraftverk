import type { SqlDatabase } from './database.ts';

/**
 * A home's own values, by name (`home_setting`): its policy — how much is a
 * load, the reserve. Each name is one the schema lists: nothing else is kept
 * here. Made for one home, or for whichever home a function names when it
 * is asked (the family's first, until devices stand in homes).
 */
export type HomeSettingKey = 'policy.values';

export class HomeSettings {
  readonly #db: SqlDatabase;
  readonly #home: () => string;

  constructor(db: SqlDatabase, home: string | (() => string)) {
    this.#db = db;
    this.#home = typeof home === 'string' ? () => home : home;
  }

  /** What was settled, or null if it never has been. */
  get(key: HomeSettingKey): string | null {
    return this.#db.query<{ value: string }, [string, string]>('SELECT value FROM home_setting WHERE home_id = ? AND key = ?').get(this.#home(), key)?.value ?? null;
  }

  set(key: HomeSettingKey, value: string): void {
    this.#db
      .query<unknown, [string, string, string, string]>(
        `INSERT INTO home_setting (home_id, key, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (home_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(this.#home(), key, value, new Date().toISOString());
  }
}

/**
 * What this node has settled about the family it keeps, by name
 * (`node_setting`): in an app, whether its own family has moved to a server,
 * or a server's copy has been brought in.
 */
export type NodeSettingKey = 'family.moved' | 'family.kept';

export class NodeSettings {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** What was settled, or null if it never has been. */
  get(key: NodeSettingKey): string | null {
    return this.#db.query<{ value: string }, [string]>('SELECT value FROM node_setting WHERE key = ?').get(key)?.value ?? null;
  }

  set(key: NodeSettingKey, value: string): void {
    this.#db
      .query<unknown, [string, string, string]>(
        `INSERT INTO node_setting (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, new Date().toISOString());
  }
}
