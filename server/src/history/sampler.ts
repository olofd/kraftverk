import type { SeriesPoint } from '@kraftverk/api-contract';
import { keepsHistory, type DeviceDescription, type Value } from '@kraftverk/device-sdk';

import { db } from './db.ts';
import type { DeviceRegistry } from '../devices/registry.ts';

/**
 * Writes one sample per device attribute, once a minute.
 *
 * Generic by construction: it records whatever a device's description says to
 * keep, so a plug added next year gets charts without a line of code here.
 * That is the same trade the narrow `sample` table makes — no schema knows
 * what a "watt" is, which is why no schema change is needed when something new
 * starts measuring one.
 *
 * Numbers and on/off go in `value` (on/off as 1/0, so one column charts every
 * quantity); an operating mode or any text goes in `text`. Nulls — a device
 * that has not reported — are skipped rather than written as zero: a gap in a
 * chart is honest, a zero is a lie about what was happening.
 */

/** Where a value is kept in a sample, or null when it is not a value to keep. */
export function sampleOf(value: Value | undefined): { value: number | null; text: string | null } | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return { value: value ? 1 : 0, text: null };
  if (typeof value === 'number') return Number.isFinite(value) ? { value, text: null } : null;
  return { value: null, text: value };
}

/** Which of a device's attributes history keeps, by key. */
export const keptKeys = (description: DeviceDescription): Set<string> =>
  new Set(description.attributes.filter((attribute) => keepsHistory(attribute)).map((attribute) => attribute.key));

const INTERVAL_MS = 60_000;
/**
 * A reading older than this is not sampled. A device that stops answering
 * keeps its last reading, and sampling that every minute drew a flat line
 * through the outage — as confident as the real data either side of it.
 */
const STALE_MS = 2 * INTERVAL_MS;
/** Two weeks of minute samples is a few hundred thousand rows. Plenty, and small. */
const RETAIN_DAYS = 14;
/** Hourly roll-ups: two years, for charts that reach back and for calibrating forecasts. */
const RETAIN_HOURLY_DAYS = 730;
/** The audit timeline: a year of who did what. */
const RETAIN_AUDIT_DAYS = 365;
/** How far back each roll-up looks: late readings from an app that was offline land in hours already rolled up. */
const ROLLUP_WINDOW_MS = 48 * 3_600_000;
/** Spans longer than this are drawn from the hourly roll-ups. */
const HOURLY_ABOVE_HOURS = 48;

export class Sampler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #pruneTimer: ReturnType<typeof setInterval> | null = null;
  #rollupTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Stops a slow round from overlapping the next one.
   *
   * The interval fires regardless of whether the previous sample finished, so a
   * round that outran a minute would have a second one starting on top of it —
   * two passes over every device, and two write transactions racing for the
   * same table. A skipped sample is a one-minute gap in a chart; overlapping
   * ones are load that grows with every device added.
   */
  #sampling = false;

  constructor(private registry: DeviceRegistry) {}

  start(): void {
    this.#timer ??= setInterval(() => void this.sample(), INTERVAL_MS);
    this.#pruneTimer ??= setInterval(() => this.prune(), 6 * 60 * 60_000);
    this.#rollupTimer ??= setInterval(() => rollUp(), 10 * 60_000);
    void this.sample();
    rollUp();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    if (this.#rollupTimer) clearInterval(this.#rollupTimer);
    this.#timer = null;
    this.#pruneTimer = null;
    this.#rollupTimer = null;
  }

  async sample(): Promise<void> {
    if (this.#sampling) return;
    this.#sampling = true;

    let devices;
    try {
      devices = await this.registry.all();
    } catch {
      return; // a failed read is a missing sample, not a crashed server
    } finally {
      this.#sampling = false;
    }

    const now = Date.now();
    const at = new Date(now).toISOString();
    const fresh = (readingAt: string | null | undefined) => {
      if (!readingAt) return true; // a reading that does not say when is taken as current
      const taken = Date.parse(readingAt);
      return !Number.isFinite(taken) || now - taken <= STALE_MS;
    };
    const insert = db().query('INSERT OR REPLACE INTO sample (device_id, key, at, value, text) VALUES (?, ?, ?, ?, ?)');

    // A device deleted since it was read has no history to add to: skipped, not a failed tick.
    const exists = db().query('SELECT 1 FROM device WHERE id = ?');

    const write = db().transaction(() => {
      for (const device of devices) {
        if (!exists.get(device.id)) continue;
        const kept = keptKeys(device.description);
        for (const reading of device.readings) {
          if (!kept.has(reading.key) || !fresh(reading.at)) continue;
          const sample = sampleOf(reading.value);
          if (sample) insert.run(device.id, reading.key, at, sample.value, sample.text);
        }
      }
    });

    write();
  }

  /** Minute samples go after two weeks — rolled up first — hourly ones after two years, the audit and device events after one. */
  prune(now = Date.now()): void {
    const before = (days: number) => new Date(now - days * 86_400_000).toISOString();
    rollUp(before(RETAIN_DAYS + 2), before(RETAIN_DAYS - 1));
    db().query('DELETE FROM sample WHERE at < ?').run(before(RETAIN_DAYS));
    db().query('DELETE FROM sample_hour WHERE hour < ?').run(before(RETAIN_HOURLY_DAYS));
    db().query('DELETE FROM audit WHERE at < ?').run(before(RETAIN_AUDIT_DAYS));
    // What a device said happened is kept as long as what was done to it.
    db().query('DELETE FROM device_event WHERE at < ?').run(before(RETAIN_AUDIT_DAYS));
  }
}

/** The start of the hour an ISO time falls in, as the roll-ups key it. */
const hourOf = (iso: string) => `${iso.slice(0, 13)}:00:00.000Z`;

/**
 * Rolls minute samples up into hours, between two times — by default the last
 * two days. Idempotent: an hour is recomputed from its samples, so rolling it
 * up again after late readings arrived corrects it rather than counting twice.
 */
export function rollUp(fromIso = new Date(Date.now() - ROLLUP_WINDOW_MS).toISOString(), toIso = new Date().toISOString()): void {
  db()
    .query(
      `INSERT OR REPLACE INTO sample_hour (device_id, key, hour, min, avg, max, n)
         SELECT device_id, key, substr(at, 1, 13) || ':00:00.000Z', min(value), avg(value), max(value), count(*)
         FROM sample WHERE value IS NOT NULL AND at >= ? AND at < ?
         GROUP BY device_id, key, substr(at, 1, 13)`
    )
    .run(hourOf(fromIso), toIso);
}

/** Minute samples for a short span; hourly roll-ups for a long one, and for anything older than the minutes kept. */
export function resolutionOf(fromIso: string, toIso: string): 'minute' | 'hour' {
  const span = (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000;
  const oldest = Date.now() - RETAIN_DAYS * 86_400_000;
  return span > HOURLY_ABOVE_HOURS || Date.parse(fromIso) < oldest ? 'hour' : 'minute';
}

/**
 * One measurement over a window, thinned to at most `points`.
 *
 * Thinning happens in SQL rather than in the app: a fortnight of minute samples
 * is 20 000 points for a chart 300 pixels wide, and shipping them all would
 * make the phone do arithmetic it cannot show.
 */
export function series(
  deviceId: string,
  key: string,
  fromIso: string,
  toIso: string,
  points = 240
): SeriesPoint[] {
  const rows = resolutionOf(fromIso, toIso) === 'hour'
    ? db()
        .query<{ at: string; value: number }, [string, string, string, string]>(
          'SELECT hour AS at, avg AS value FROM sample_hour WHERE device_id = ? AND key = ? AND hour >= ? AND hour <= ? ORDER BY hour'
        )
        .all(deviceId, key, hourOf(fromIso), toIso)
    : db()
        .query<{ at: string; value: number }, [string, string, string, string]>(
          'SELECT at, value FROM sample WHERE device_id = ? AND key = ? AND at >= ? AND at <= ? ORDER BY at'
        )
        .all(deviceId, key, fromIso, toIso);

  if (rows.length <= points) return rows;

  const stride = rows.length / points;
  const thinned: SeriesPoint[] = [];
  for (let index = 0; index < points; index++) {
    const slice = rows.slice(Math.floor(index * stride), Math.floor((index + 1) * stride));
    if (slice.length === 0) continue;
    // The mean, not a sample: a spike that vanishes when you zoom out is worse
    // than one that shows as a smaller bump.
    const mean = slice.reduce((sum, row) => sum + row.value, 0) / slice.length;
    thinned.push({ at: slice[Math.floor(slice.length / 2)]!.at, value: mean });
  }
  return thinned;
}
