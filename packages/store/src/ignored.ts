import { savedDeviceId, type SavedDeviceId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * What a person said not to offer again (docs/PLAN-INTEGRATIONS.md §4.4): a
 * sighting on a transport, or a member behind a bridge, they do not mean to
 * add. Named as a connection names a device — its transport and address,
 * and for a member its bridge — so the next time it is seen it is known.
 */

/** Where something was found: on a transport at an address; or, for a member, behind a bridge by its key. */
export type SightingPlace = { transport: string; through: SavedDeviceId | null; address: string };

export type IgnoredRecord = SightingPlace & { ignoredAt: string };

type Row = { transport: string; through: string | null; address: string; ignored_at: string };

export class IgnoredSightings {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  all(): IgnoredRecord[] {
    return this.#db
      .query<Row, []>('SELECT * FROM sighting_ignored ORDER BY ignored_at')
      .all()
      .map((row) => ({ transport: row.transport, through: row.through === null ? null : savedDeviceId(row.through), address: row.address, ignoredAt: row.ignored_at }));
  }

  /** Whether something found there was said not to be offered. */
  has(at: SightingPlace): boolean {
    return this.#db.query<{ n: number }, [string, string, string]>("SELECT 1 AS n FROM sighting_ignored WHERE transport = ? AND coalesce(through, '') = ? AND address = ?").get(at.transport, at.through ?? '', at.address) !== null;
  }

  ignore(at: SightingPlace): void {
    this.#db
      .query("INSERT INTO sighting_ignored (transport, through, address, ignored_at) VALUES (?, ?, ?, ?) ON CONFLICT (transport, coalesce(through, ''), address) DO NOTHING")
      .run(at.transport, at.through, at.address, new Date().toISOString());
  }

  /** Offered again. */
  unignore(at: SightingPlace): void {
    this.#db.query("DELETE FROM sighting_ignored WHERE transport = ? AND coalesce(through, '') = ? AND address = ?").run(at.transport, at.through ?? '', at.address);
  }
}
