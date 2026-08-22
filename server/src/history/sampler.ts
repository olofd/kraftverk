import { db } from './db.ts';
import type { DeviceRegistry } from '../devices/registry.ts';

/**
 * Writes one sample per device measurement, once a minute.
 *
 * Generic by construction: it records whatever devices declare, so a plug added
 * next year gets charts without a line of code here. That is the same trade the
 * narrow `sample` table makes — no schema knows what a "watt" is, which is why
 * no schema change is needed when something new starts measuring one.
 *
 * Booleans are stored as 0/1 so one column serves every kind. Nulls — a device
 * that has not reported — are skipped rather than written as zero: a gap in a
 * chart is honest, a zero is a lie about what was happening.
 */

const INTERVAL_MS = 60_000;
/** Two weeks of minute samples is a few hundred thousand rows. Plenty, and small. */
const RETAIN_DAYS = 14;

export class Sampler {
  #timer: ReturnType<typeof setInterval> | null = null;
  #pruneTimer: ReturnType<typeof setInterval> | null = null;
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
    void this.sample();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    this.#timer = null;
    this.#pruneTimer = null;
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

    const at = new Date().toISOString();
    const insert = db().query(
      'INSERT OR REPLACE INTO sample (device_id, key, at, value) VALUES (?, ?, ?, ?)'
    );

    const write = db().transaction(() => {
      for (const device of devices) {
        for (const reading of device.readings) {
          if (reading.value === null || reading.value === undefined) continue;
          const numeric = typeof reading.value === 'boolean' ? (reading.value ? 1 : 0) : reading.value;
          if (!Number.isFinite(numeric)) continue;
          insert.run(device.id, reading.key, at, numeric);
        }
      }
    });

    write();
  }

  prune(): void {
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 86_400_000).toISOString();
    db().query('DELETE FROM sample WHERE at < ?').run(cutoff);
  }
}

export type SeriesPoint = { at: string; value: number };

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
  const rows = db()
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
