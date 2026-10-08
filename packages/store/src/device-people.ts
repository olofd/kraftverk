import type { DevicePeople, DeviceRole } from '@kraftverk/api-contract';

import type { SqlDatabase } from './database.ts';

/**
 * Who a device is with (docs/PLAN-WORLD-MODEL.md §8.8): who carries it — its
 * position is theirs — its usual driver, whose it is, and who uses it. Kept
 * as intervals: a carrier changed closes one row and opens the next, so who
 * carried it when is history. One carrier at a time, and one usual driver.
 */

export const DEVICE_ROLES = ['carries', 'drives', 'owns', 'uses'] as const satisfies readonly DeviceRole[];

/** Roles one person at a time fills. */
const ONE = new Set<DeviceRole>(['carries', 'drives']);

const NOBODY = (): DevicePeople => ({ carries: null, drives: null, owns: [], uses: [] });

export class DevicePeopleStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** Who a device is with now. */
  of(deviceId: string): DevicePeople {
    const people = NOBODY();
    for (const row of this.#db
      .query<{ person_id: string; role: DeviceRole }, [string]>('SELECT person_id, role FROM device_person WHERE device_id = ? AND until IS NULL ORDER BY since, person_id')
      .all(deviceId)) {
      if (ONE.has(row.role)) people[row.role as 'carries' | 'drives'] = row.person_id;
      else people[row.role as 'owns' | 'uses'].push(row.person_id);
    }
    return people;
  }

  /** Every device's, at once: what a list of devices shows. */
  all(): Map<string, DevicePeople> {
    const all = new Map<string, DevicePeople>();
    for (const row of this.#db
      .query<{ device_id: string; person_id: string; role: DeviceRole }, []>('SELECT device_id, person_id, role FROM device_person WHERE until IS NULL ORDER BY since, person_id')
      .all()) {
      const people = all.get(row.device_id) ?? NOBODY();
      if (ONE.has(row.role)) people[row.role as 'carries' | 'drives'] = row.person_id;
      else people[row.role as 'owns' | 'uses'].push(row.person_id);
      all.set(row.device_id, people);
    }
    return all;
  }

  /** The devices a person carries now: where they are is where these are. */
  carriedBy(personId: string): string[] {
    return this.#db
      .query<{ device_id: string }, [string]>("SELECT device_id FROM device_person WHERE person_id = ? AND role = 'carries' AND until IS NULL ORDER BY since")
      .all(personId)
      .map((row) => row.device_id);
  }

  /**
   * Who fills a role now, as given: those no longer in it end there, those
   * new to it begin. One person at most for carries and drives.
   */
  set(deviceId: string, role: DeviceRole, personIds: readonly string[], at: string): void {
    if (ONE.has(role) && personIds.length > 1) throw new Error(`One person at a time ${role === 'carries' ? 'carries' : 'drives'} a device`);
    const wanted = new Set(personIds);
    this.#db.transaction(() => {
      const now = this.#db.query<{ person_id: string }, [string, string]>('SELECT person_id FROM device_person WHERE device_id = ? AND role = ? AND until IS NULL').all(deviceId, role);
      // Ended: a row begun this very instant was never so, and goes.
      const end = this.#db.query('UPDATE device_person SET until = ? WHERE device_id = ? AND role = ? AND person_id = ? AND until IS NULL AND since < ?');
      const never = this.#db.query('DELETE FROM device_person WHERE device_id = ? AND role = ? AND person_id = ? AND until IS NULL AND since >= ?');
      for (const { person_id } of now) if (!wanted.has(person_id)) (end.run(at, deviceId, role, person_id, at), never.run(deviceId, role, person_id, at));
      const had = new Set(now.map((row) => row.person_id));
      const begin = this.#db.query('INSERT INTO device_person (device_id, person_id, role, since, until) VALUES (?, ?, ?, ?, NULL)');
      for (const personId of wanted) if (!had.has(personId)) begin.run(deviceId, personId, role, at);
    })();
  }

  /** A person no longer with any device: they left, or were forgotten. */
  endFor(personId: string, at: string): void {
    this.#db.query('UPDATE device_person SET until = ? WHERE person_id = ? AND until IS NULL AND since < ?').run(at, personId, at);
    this.#db.query('DELETE FROM device_person WHERE person_id = ? AND until IS NULL AND since >= ?').run(personId, at);
  }
}
