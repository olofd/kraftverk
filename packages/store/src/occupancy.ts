import { newId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * Whether a space has someone in it (docs/PLAN-WORLD-MODEL.md §8.9): intervals,
 * the open one now, with the devices that said so. Kept 30 days; never on the
 * timeline, never in the configuration file.
 */

export type OccupancyRecord = { id: string; spaceId: string; homeId: string; since: string; until: string | null; peak: number | null; devices: string[] };

type Row = { id: string; space_id: string; home_id: string; since: string; until: string | null; peak: number | null };

const SELECT = 'SELECT o.id, o.space_id, s.home_id, o.since, o.until, o.peak FROM occupancy o JOIN space s ON s.id = o.space_id';

export class OccupancyStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  #of(row: Row): OccupancyRecord {
    const devices = this.#db.query<{ device_id: string }, [string]>('SELECT device_id FROM occupancy_evidence WHERE occupancy_id = ? ORDER BY device_id').all(row.id);
    return { id: row.id, spaceId: row.space_id, homeId: row.home_id, since: row.since, until: row.until, peak: row.peak, devices: devices.map((each) => each.device_id) };
  }

  /** A home's spaces with someone in them now. */
  open(homeId: string): OccupancyRecord[] {
    return this.#db.query<Row, [string]>(`${SELECT} WHERE s.home_id = ? AND o.until IS NULL ORDER BY o.since`).all(homeId).map((row) => this.#of(row));
  }

  /** A space's occupancy since a time, newest first: the open one too. */
  since(spaceId: string, since: string): OccupancyRecord[] {
    return this.#db.query<Row, [string, string]>(`${SELECT} WHERE o.space_id = ? AND (o.until IS NULL OR o.until > ?) ORDER BY o.since DESC`).all(spaceId, since).map((row) => this.#of(row));
  }

  /** Someone is there from `since`: what said so, and how many when counted. */
  begin(spaceId: string, since: string, devices: readonly string[], peak: number | null): string {
    const id = newId('oc');
    this.#db.transaction(() => {
      this.#db.query('INSERT INTO occupancy (id, space_id, since, until, peak) VALUES (?, ?, ?, NULL, ?)').run(id, spaceId, since, peak && peak > 0 ? peak : null);
      this.#evidence(id, devices);
    })();
    return id;
  }

  /** More said so, or more were counted, while it lasts. */
  extend(id: string, devices: readonly string[], peak: number | null): void {
    this.#db.transaction(() => {
      this.#evidence(id, devices);
      if (peak && peak > 0) this.#db.query('UPDATE occupancy SET peak = max(coalesce(peak, 0), ?) WHERE id = ?').run(peak, id);
    })();
  }

  #evidence(id: string, devices: readonly string[]): void {
    const insert = this.#db.query('INSERT OR IGNORE INTO occupancy_evidence (occupancy_id, device_id) SELECT ?, id FROM device WHERE id = ?');
    for (const device of new Set(devices)) insert.run(id, device);
  }

  /** Nobody is there any more: ended after it began, whenever that was. */
  end(id: string, until: string): void {
    const row = this.#db.query<{ since: string }, [string]>('SELECT since FROM occupancy WHERE id = ? AND until IS NULL').get(id);
    if (!row) return;
    const at = until > row.since ? until : new Date(Date.parse(row.since) + 1).toISOString();
    this.#db.query('UPDATE occupancy SET until = ? WHERE id = ?').run(at, id);
  }

  /** What ended before a time, let go: kept 30 days. */
  prune(before: string): number {
    return this.#db.query('DELETE FROM occupancy WHERE until IS NOT NULL AND until < ?').run(before).changes;
  }
}
