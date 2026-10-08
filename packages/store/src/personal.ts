import type { Statement } from '@kraftverk/identity';

import type { SqlDatabase } from './database.ts';

/*
  The personal store (docs/PLAN-WORLD-MODEL.md §7, §10.6): what one device
  keeps of the accounts on it, before and beside any family — each
  person's chain, where this device's key for them is, whether they wrote
  their recovery words down, and the families they are in, with where
  each one's master is. One file per device, its own schema and
  fingerprint, set aside when that changes as a family's is. No private
  key is ever in it: the platform keeps those, by the person's id.
*/

export const PERSONAL_SCHEMA = `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY CHECK (key IN ('schema_hash', 'created_at', 'created_by_version')),
    value TEXT NOT NULL
  );

  /* An account on this device: a person, their chain, and this device's key for them. */
  CREATE TABLE me (
    person_id    TEXT PRIMARY KEY CHECK (person_id GLOB 'p-*'),
    /* Their statements, as JSON: who they are, as they prove it. */
    chain        TEXT NOT NULL,
    /* This device's key for them, k-…: its private half kept by the platform, by the person's id. */
    key_id       TEXT NOT NULL CHECK (key_id GLOB 'k-*'),
    device_name  TEXT NOT NULL CHECK (length(device_name) BETWEEN 1 AND 60),
    /* When they showed they had written their recovery words down; null: not yet. */
    recovery_confirmed_at TEXT,
    added_at     TEXT NOT NULL,
    /* The one this device opens as now: one at a time, or none — signed out. */
    active       INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1))
  );
  CREATE UNIQUE INDEX me_active ON me (active) WHERE active = 1;

  /* A family an account is in, and where its master is: this device, or a server. */
  CREATE TABLE my_family (
    person_id  TEXT NOT NULL REFERENCES me (person_id) ON DELETE CASCADE,
    family_id  TEXT NOT NULL CHECK (family_id GLOB 'f-*'),
    name       TEXT NOT NULL,
    master     TEXT NOT NULL CHECK (master IN ('here', 'server')),
    /* Where the server is, for one whose master is a server. */
    server_url TEXT,
    joined_at  TEXT NOT NULL,
    PRIMARY KEY (person_id, family_id),
    CHECK ((master = 'server') = (server_url IS NOT NULL))
  );
`;

export type MyAccount = { personId: string; chain: Statement[]; keyId: string; deviceName: string; recoveryConfirmedAt: string | null; addedAt: string; active: boolean };
export type MyFamily = { familyId: string; name: string; master: 'here' | 'server'; serverUrl: string | null; joinedAt: string };

type MeRow = { person_id: string; chain: string; key_id: string; device_name: string; recovery_confirmed_at: string | null; added_at: string; active: number };
type FamilyRow = { family_id: string; name: string; master: 'here' | 'server'; server_url: string | null; joined_at: string };

const accountOf = (row: MeRow): MyAccount => ({
  personId: row.person_id,
  chain: JSON.parse(row.chain) as Statement[],
  keyId: row.key_id,
  deviceName: row.device_name,
  recoveryConfirmedAt: row.recovery_confirmed_at,
  addedAt: row.added_at,
  active: row.active === 1,
});

export class PersonalStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** The accounts on this device, in the order they were added. */
  accounts(): MyAccount[] {
    return this.#db.query<MeRow, []>('SELECT * FROM me ORDER BY added_at, person_id').all().map(accountOf);
  }

  account(personId: string): MyAccount | null {
    const row = this.#db.query<MeRow, [string]>('SELECT * FROM me WHERE person_id = ?').get(personId);
    return row ? accountOf(row) : null;
  }

  /** The account this device opens as now, if any. */
  active(): MyAccount | null {
    const row = this.#db.query<MeRow, []>('SELECT * FROM me WHERE active = 1').get();
    return row ? accountOf(row) : null;
  }

  add(account: Omit<MyAccount, 'active' | 'recoveryConfirmedAt'>): MyAccount {
    this.#db.query('INSERT INTO me (person_id, chain, key_id, device_name, added_at) VALUES (?, ?, ?, ?, ?)').run(account.personId, JSON.stringify(account.chain), account.keyId, account.deviceName, account.addedAt);
    return this.account(account.personId)!;
  }

  /** Their chain as it is now: longer, after a statement. */
  keepChain(personId: string, chain: readonly Statement[]): void {
    this.#db.query('UPDATE me SET chain = ? WHERE person_id = ?').run(JSON.stringify(chain), personId);
  }

  confirmRecovery(personId: string, at: string): void {
    this.#db.query('UPDATE me SET recovery_confirmed_at = ? WHERE person_id = ?').run(at, personId);
  }

  /** The account this device opens as from now — one, or none: signed out. */
  activate(personId: string | null): void {
    this.#db.transaction(() => {
      this.#db.query('UPDATE me SET active = 0 WHERE active = 1').run();
      if (personId) this.#db.query('UPDATE me SET active = 1 WHERE person_id = ?').run(personId);
    })();
  }

  /** An account forgotten by this device, with its families. Its key is the platform's to forget. */
  remove(personId: string): void {
    this.#db.query('DELETE FROM me WHERE person_id = ?').run(personId);
  }

  families(personId: string): MyFamily[] {
    return this.#db
      .query<FamilyRow, [string]>('SELECT * FROM my_family WHERE person_id = ? ORDER BY joined_at, family_id')
      .all(personId)
      .map((row) => ({ familyId: row.family_id, name: row.name, master: row.master, serverUrl: row.server_url, joinedAt: row.joined_at }));
  }

  /** A family an account is in, or what it is now called. */
  keepFamily(personId: string, family: MyFamily): void {
    this.#db
      .query('INSERT INTO my_family (person_id, family_id, name, master, server_url, joined_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (person_id, family_id) DO UPDATE SET name = excluded.name, master = excluded.master, server_url = excluded.server_url')
      .run(personId, family.familyId, family.name, family.master, family.serverUrl, family.joinedAt);
  }
}
