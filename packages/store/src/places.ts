import { KEY, keyFrom } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';
import { randomHex } from './ids.ts';

/**
 * Where things are, physically (docs/DATA-MODEL.md §3): a home is somewhere
 * — one place or several, each with its position and its clock. A device and
 * a node stand at one; weather, sun times and an automation's clock are read
 * from it.
 */

export type PlaceRecord = {
  id: string;
  /** Its name in configuration: `home`, `cabin`. */
  key: string;
  /** "Home", "The cabin". */
  name: string;
  latitude: number;
  longitude: number;
  /** Its clock: `Europe/Stockholm`. */
  timeZone: string;
  createdAt: string;
};

/** A place as it is said: its key made from its name when not given. */
export type PlaceInput = { key?: string; name: string; latitude: number; longitude: number; timeZone: string };

type Row = { id: string; key: string; name: string; latitude: number; longitude: number; time_zone: string; created_at: string };

const toRecord = (row: Row): PlaceRecord => ({ id: row.id, key: row.key, name: row.name, latitude: row.latitude, longitude: row.longitude, timeZone: row.time_zone, createdAt: row.created_at });

export class PlaceStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  list(): PlaceRecord[] {
    return this.#db.query<Row, []>('SELECT * FROM place ORDER BY created_at').all().map(toRecord);
  }

  get(id: string): PlaceRecord | null {
    const row = this.#db.query<Row, [string]>('SELECT * FROM place WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  byKey(key: string): PlaceRecord | null {
    const row = this.#db.query<Row, [string]>('SELECT * FROM place WHERE key = ?').get(key);
    return row ? toRecord(row) : null;
  }

  add(input: PlaceInput): PlaceRecord {
    if (input.key !== undefined && (!KEY.test(input.key) || this.byKey(input.key))) throw new Error(`"${input.key}" is not a free key: lowercase letters, digits and dashes, and not another place's`);
    const record: PlaceRecord = {
      id: `p-${randomHex(6)}`,
      key: input.key ?? keyFrom(input.name, (key) => this.byKey(key) !== null, 'place'),
      name: input.name,
      latitude: input.latitude,
      longitude: input.longitude,
      timeZone: input.timeZone,
      createdAt: new Date().toISOString(),
    };
    this.#db
      .query('INSERT INTO place (id, key, name, latitude, longitude, time_zone, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(record.id, record.key, record.name, record.latitude, record.longitude, record.timeZone, record.createdAt);
    return record;
  }

  update(id: string, changes: Partial<PlaceInput>): PlaceRecord | null {
    const had = this.get(id);
    if (!had) return null;
    if (changes.key !== undefined && changes.key !== had.key && (!KEY.test(changes.key) || this.byKey(changes.key))) throw new Error(`"${changes.key}" is not a free key`);
    const next = { ...had, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) } as PlaceRecord;
    this.#db
      .query('UPDATE place SET key = ?, name = ?, latitude = ?, longitude = ?, time_zone = ? WHERE id = ?')
      .run(next.key, next.name, next.latitude, next.longitude, next.timeZone, id);
    return next;
  }

  /** Removes a place: what stood at it stands nowhere said. */
  remove(id: string): void {
    this.#db.query('DELETE FROM place WHERE id = ?').run(id);
  }
}
