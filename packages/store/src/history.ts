import type { SqlDatabase } from './database.ts';

/**
 * A home's history, as it is kept (docs/DATA-MODEL.md, `sample`,
 * `sample_hour`, `sample_change`): minute samples of what a device reports,
 * their hourly roll-ups, and every change of an on/off or an enum at the
 * moment the device observed it. What is sampled, when, and for how long it
 * is kept is the hub's to decide; this keeps it, reads it back and lets it go.
 */

/** One value of one attribute at one time: a number, or text; on/off kept as 1 and 0. */
export type Sample = { deviceId: string; part: string; key: string; at: string; value: number | null; text: string | null };

/** A point of a series: when, and the value — a minute's, or an hour's mean. */
export type SeriesRow = { at: string; value: number };

/** One change in the log, as kept. */
export type ChangeRow = { key: string; part: string; at: string; value: number | null; text: string | null };

type Kept = { at: string; value: number | null; text: string | null };

const same = (row: Kept | null | undefined, sample: { value: number | null; text: string | null }) => row != null && row.value === sample.value && row.text === sample.text;

/** The start of the hour an ISO time falls in, as the roll-ups key it. */
const hourOf = (iso: string) => `${iso.slice(0, 13)}:00:00.000Z`;

export class HistoryStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** Samples, in one go — one of a device deleted since it was read is skipped. Returns how many were kept. */
  addSamples(samples: readonly Sample[]): number {
    if (!samples.length) return 0;
    const insert = this.#db.query('INSERT OR REPLACE INTO sample (device_id, part, key, at, value, text) VALUES (?, ?, ?, ?, ?, ?)');
    const exists = this.#db.query('SELECT 1 FROM device WHERE id = ?');
    let kept = 0;
    this.#db.transaction(() => {
      const known = new Map<string, boolean>();
      for (const sample of samples) {
        if (!known.has(sample.deviceId)) known.set(sample.deviceId, Boolean(exists.get(sample.deviceId)));
        if (!known.get(sample.deviceId)) continue;
        insert.run(sample.deviceId, sample.part, sample.key, sample.at, sample.value, sample.text);
        kept += 1;
      }
    })();
    return kept;
  }

  /** One attribute's samples between two times, oldest first, as kept. */
  samples(deviceId: string, key: string, fromIso: string, toIso: string): Kept[] {
    return this.#db
      .query<Kept, [string, string, string, string]>('SELECT at, value, text FROM sample WHERE device_id = ? AND key = ? AND at >= ? AND at <= ? ORDER BY at')
      .all(deviceId, key, fromIso, toIso);
  }

  /**
   * Rolls minute samples up into hours, between two times. Idempotent: an
   * hour is recomputed from its samples, so rolling it up again after late
   * readings arrived corrects it rather than counting twice.
   */
  rollUp(fromIso: string, toIso: string): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO sample_hour (device_id, part, key, hour, min, avg, max, n)
           SELECT device_id, part, key, substr(at, 1, 13) || ':00:00.000Z', min(value), avg(value), max(value), count(*)
           FROM sample WHERE value IS NOT NULL AND at >= ? AND at < ?
           GROUP BY device_id, part, key, substr(at, 1, 13)`
      )
      .run(hourOf(fromIso), toIso);
  }

  /** One measurement between two times, oldest first: its minute samples, or its hourly means. */
  series(deviceId: string, key: string, fromIso: string, toIso: string, resolution: 'minute' | 'hour'): SeriesRow[] {
    return resolution === 'hour'
      ? this.#db
          .query<SeriesRow, [string, string, string, string]>('SELECT hour AS at, avg AS value FROM sample_hour WHERE device_id = ? AND key = ? AND hour >= ? AND hour <= ? ORDER BY hour')
          .all(deviceId, key, hourOf(fromIso), toIso)
      : this.#db
          .query<SeriesRow, [string, string, string, string]>('SELECT at, value FROM sample WHERE device_id = ? AND key = ? AND at >= ? AND at <= ? ORDER BY at')
          .all(deviceId, key, fromIso, toIso);
  }

  /**
   * Changes, into the log of one device — a device deleted since is
   * skipped. One that says what the row before it already says is no
   * change and writes nothing; one that arrives late lands in its place in
   * time, and the row after it goes if it no longer changes anything.
   * Returns how many were written.
   */
  recordChanges(deviceId: string, changes: readonly Omit<Sample, 'deviceId'>[]): number {
    if (!changes.length) return 0;
    const before = this.#db.query<Kept, [string, string, string]>('SELECT at, value, text FROM sample_change WHERE device_id = ? AND key = ? AND at <= ? ORDER BY at DESC LIMIT 1');
    const after = this.#db.query<Kept, [string, string, string]>('SELECT at, value, text FROM sample_change WHERE device_id = ? AND key = ? AND at > ? ORDER BY at ASC LIMIT 1');
    const insert = this.#db.query('INSERT OR REPLACE INTO sample_change (device_id, part, key, at, value, text) VALUES (?, ?, ?, ?, ?, ?)');
    const drop = this.#db.query('DELETE FROM sample_change WHERE device_id = ? AND key = ? AND at = ?');
    let written = 0;
    this.#db.transaction(() => {
      if (!this.#db.query('SELECT 1 FROM device WHERE id = ?').get(deviceId)) return;
      for (const change of changes) {
        if (same(before.get(deviceId, change.key, change.at), change)) continue;
        insert.run(deviceId, change.part, change.key, change.at, change.value, change.text);
        written += 1;
        const next = after.get(deviceId, change.key, change.at);
        if (same(next, change)) drop.run(deviceId, change.key, next!.at);
      }
    })();
    return written;
  }

  /** The changes between two times, oldest first — with, for each key, the one before \`from\`, so the span starts knowing what each was. */
  changes(deviceId: string, options: { from: string; to: string; key?: string }): ChangeRow[] {
    const keyed = options.key ? ' AND key = ?' : '';
    const keyArgs = options.key ? [options.key] : [];
    return this.#db
      .query<ChangeRow, string[]>(
        `SELECT key, part, at, value, text FROM sample_change WHERE device_id = ?${keyed} AND at > ? AND at <= ?
         UNION ALL
         SELECT key, part, MAX(at) AS at, value, text FROM sample_change WHERE device_id = ?${keyed} AND at <= ? GROUP BY key
         ORDER BY at ASC, key ASC`
      )
      .all(deviceId, ...keyArgs, options.from, options.to, deviceId, ...keyArgs, options.from);
  }

  /**
   * Lets go of what is older than kept: minute samples, hourly means, and
   * changes — except each key's latest change, what it has been since.
   */
  prune(before: { samples: string; hours: string; changes: string }): void {
    this.#db.query('DELETE FROM sample WHERE at < ?').run(before.samples);
    this.#db.query('DELETE FROM sample_hour WHERE hour < ?').run(before.hours);
    this.#db
      .query(
        `DELETE FROM sample_change WHERE at < ? AND at < (
           SELECT MAX(latest.at) FROM sample_change latest WHERE latest.device_id = sample_change.device_id AND latest.key = sample_change.key
         )`
      )
      .run(before.changes);
  }
}
