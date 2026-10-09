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

  /** A stay ends: after it began, whenever that was. */
  end(stayId: string, until: string): void {
    const row = this.#db.query<{ since: string }, [string]>('SELECT since FROM presence_stay WHERE id = ? AND until IS NULL').get(stayId);
    if (!row) return;
    this.#db.query('UPDATE presence_stay SET until = ? WHERE id = ?').run(until > row.since ? until : new Date(Date.parse(row.since) + 1).toISOString(), stayId);
  }

  /** The room a person is in now, by a signal that tells people apart: none when none says so. */
  room(personId: string): { id: string; spaceId: string; since: string; deviceId: string | null } | null {
    const row = this.#db
      .query<{ id: string; space_id: string; since: string; device_id: string | null }, [string]>('SELECT id, space_id, since, device_id FROM presence_stay WHERE person_id = ? AND until IS NULL AND space_id IS NOT NULL')
      .get(personId);
    return row ? { id: row.id, spaceId: row.space_id, since: row.since, deviceId: row.device_id } : null;
  }

  /** Who is in which room of a home now: each room stay, and what placed them there. */
  rooms(homeId: string): { personId: string; spaceId: string; since: string; deviceId: string | null }[] {
    return this.#db
      .query<{ person_id: string; space_id: string; since: string; device_id: string | null }, [string]>(
        'SELECT p.person_id, p.space_id, p.since, p.device_id FROM presence_stay p JOIN space s ON s.id = p.space_id WHERE s.home_id = ? AND p.until IS NULL ORDER BY p.since'
      )
      .all(homeId)
      .map((row) => ({ personId: row.person_id, spaceId: row.space_id, since: row.since, deviceId: row.device_id }));
  }

  /** Who is in which room now, in every home: each room stay, its home beside it. */
  allRooms(): { personId: string; spaceId: string; homeId: string; since: string; deviceId: string | null }[] {
    return this.#db
      .query<{ person_id: string; space_id: string; home_id: string; since: string; device_id: string | null }, []>(
        'SELECT p.person_id, p.space_id, s.home_id, p.since, p.device_id FROM presence_stay p JOIN space s ON s.id = p.space_id WHERE p.until IS NULL ORDER BY p.since'
      )
      .all()
      .map((row) => ({ personId: row.person_id, spaceId: row.space_id, homeId: row.home_id, since: row.since, deviceId: row.device_id }));
  }

  /** Everything open of a person's ended at a time: they left the family. */
  endAll(personId: string, at: string): void {
    for (const row of this.#db.query<{ id: string }, [string]>('SELECT id FROM presence_stay WHERE person_id = ? AND until IS NULL').all(personId)) this.end(row.id, at);
  }

  /** A person is in a room from `since`, by what they carry. */
  enterRoom(personId: string, spaceId: string, since: string, deviceId: string | null): string {
    const id = `st-${Date.now().toString(36)}-${(this.#next++).toString(36)}`;
    this.#db.query('INSERT INTO presence_stay (id, person_id, place_id, place_kind, space_id, since, until, device_id) VALUES (?, ?, NULL, NULL, ?, ?, NULL, ?)').run(id, personId, spaceId, since, deviceId);
    return id;
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
