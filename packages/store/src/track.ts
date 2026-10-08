import type { SavedDeviceId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * Where a device has been (docs/DATA-MODEL.md, `track`), kept only while its
 * owner keeps it (`DeviceRecord.trackDays`, set by the catalog, which also
 * forgets it all when that is turned off). Nothing of it is exported: where
 * someone was is not part of a home's configuration.
 *
 * A point is kept when the device has moved since the last, or when an hour
 * has gone by there: a phone on a desk located every minute is one point an
 * hour, not sixty, and a trail still says how long it stayed.
 */

/** One place a device was located, and when. `accuracy`: within how many metres — null when it did not say. */
export type TrackPoint = { at: string; latitude: number; longitude: number; accuracy: number | null };

/** Closer than this to the last point kept is the same place. */
const MOVED_M = 25;
/** And still there after this long is kept again. */
const STAYED_MS = 3_600_000;

/** Metres between two points: flat over the few kilometres a step covers, and good enough over more. */
const metres = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
  const toRad = Math.PI / 180;
  const x = (b.longitude - a.longitude) * toRad * Math.cos(((a.latitude + b.latitude) / 2) * toRad);
  const y = (b.latitude - a.latitude) * toRad;
  return Math.hypot(x, y) * 6_371_000;
};

export class TrackStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /**
   * A place the device was located, kept when it is news (see above), and
   * only for a device whose track is kept. Returns whether it was kept.
   */
  add(deviceId: SavedDeviceId, point: TrackPoint): boolean {
    const kept = this.#db.query<{ track_days: number | null }, [string]>('SELECT track_days FROM device WHERE id = ? AND removed_at IS NULL').get(deviceId);
    if (!kept?.track_days) return false;
    const last = this.latest(deviceId);
    if (last && Date.parse(point.at) <= Date.parse(last.at)) return false;
    if (last && metres(last, point) < Math.max(MOVED_M, point.accuracy ?? 0) && Date.parse(point.at) - Date.parse(last.at) < STAYED_MS) return false;
    this.#db.query('INSERT OR IGNORE INTO track (device_id, at, latitude, longitude, accuracy) VALUES (?, ?, ?, ?, ?)').run(deviceId, point.at, point.latitude, point.longitude, point.accuracy);
    return true;
  }

  /** The last place kept, or null. */
  latest(deviceId: SavedDeviceId): TrackPoint | null {
    return this.#db.query<TrackPoint, [string]>('SELECT at, latitude, longitude, accuracy FROM track WHERE device_id = ? ORDER BY at DESC LIMIT 1').get(deviceId) ?? null;
  }

  /** Where it was from `since` on, oldest first: at most `limit` points, the latest of them. */
  points(deviceId: SavedDeviceId, since: string, limit = 5000): TrackPoint[] {
    return this.#db
      .query<TrackPoint, [string, string, number]>('SELECT at, latitude, longitude, accuracy FROM (SELECT * FROM track WHERE device_id = ? AND at >= ? ORDER BY at DESC LIMIT ?) ORDER BY at')
      .all(deviceId, since, limit);
  }

  /** Everything kept of where a device has been, let go: its carrier shares less than where they are. */
  forget(deviceId: string): void {
    this.#db.query('DELETE FROM track WHERE device_id = ?').run(deviceId);
  }

  /** What each device keeps longer than its owner said, let go. Returns how many points went. */
  prune(now = Date.now()): number {
    const devices = this.#db.query<{ id: string; track_days: number }, []>('SELECT id, track_days FROM device WHERE track_days IS NOT NULL').all();
    let gone = 0;
    for (const device of devices) gone += this.#db.query('DELETE FROM track WHERE device_id = ? AND at < ?').run(device.id, new Date(now - device.track_days * 86_400_000).toISOString()).changes;
    return gone;
  }
}
