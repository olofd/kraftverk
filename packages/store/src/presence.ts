import type { SqlDatabase } from './database.ts';

/**
 * Where people have been (docs/PLAN-WORLD-MODEL.md §8.9): stays at a home or
 * in a zone, as intervals — the open ones are where they are now. Kept as
 * long as each person says (their sharing's keep days), never on the
 * timeline, never in the configuration file.
 */

export type StayRecord = { id: string; personId: string; placeId: string; kind: 'home' | 'zone'; since: string; until: string | null; deviceId: string | null };

type Row = { id: string; person_id: string; place_id: string; place_kind: 'home' | 'zone'; since: string; until: string | null; device_id: string | null };

const stayOf = (row: Row): StayRecord => ({ id: row.id, personId: row.person_id, placeId: row.place_id, kind: row.place_kind, since: row.since, until: row.until, deviceId: row.device_id });

export class PresenceStore {
  readonly #db: SqlDatabase;
  #next = 0;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** A person's stays that have not ended: where they are now. */
  open(personId: string): StayRecord[] {
    return this.#db.query<Row, [string]>('SELECT * FROM presence_stay WHERE person_id = ? AND until IS NULL AND place_id IS NOT NULL ORDER BY since').all(personId).map(stayOf);
  }

  /** Everyone's open stays: where the family is now. */
  allOpen(): StayRecord[] {
    return this.#db.query<Row, []>('SELECT * FROM presence_stay WHERE until IS NULL AND place_id IS NOT NULL ORDER BY person_id, since').all().map(stayOf);
  }

  /** A person's stays since a time, newest first. */
  since(personId: string, since: string): StayRecord[] {
    return this.#db.query<Row, [string, string]>('SELECT * FROM presence_stay WHERE person_id = ? AND (until IS NULL OR until > ?) AND place_id IS NOT NULL ORDER BY since DESC').all(personId, since).map(stayOf);
  }

  begin(personId: string, place: { id: string; kind: 'home' | 'zone' }, since: string, deviceId: string | null): string {
    const id = `st-${Date.now().toString(36)}-${(this.#next++).toString(36)}`;
    this.#db.query('INSERT INTO presence_stay (id, person_id, place_id, place_kind, space_id, since, until, device_id) VALUES (?, ?, ?, ?, NULL, ?, NULL, ?)').run(id, personId, place.id, place.kind, since, deviceId);
    return id;
  }

  end(stayId: string, until: string): void {
    this.#db.query('UPDATE presence_stay SET until = ? WHERE id = ? AND until IS NULL').run(until, stayId);
  }

  /** A person's stays that ended before a time: kept no longer than they say. */
  prune(personId: string, before: string): void {
    this.#db.query('DELETE FROM presence_stay WHERE person_id = ? AND until IS NOT NULL AND until < ?').run(personId, before);
  }

  /** Everything of where a person has been: they were forgotten. */
  forget(personId: string): void {
    this.#db.query('DELETE FROM presence_stay WHERE person_id = ?').run(personId);
  }
}
