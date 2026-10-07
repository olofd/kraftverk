import type { Reading, SavedDeviceId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * What each device last said, attribute by attribute, in `device_reading`:
 * its value, and when the device said it. What a device shows before its
 * session has said anything since this node started — a restart, a broker
 * recreated, a sensor that speaks once an hour — as what it was, and when;
 * never as what it is now (docs/DATA-MODEL.md, `device_reading`).
 *
 * Kept as the holder says it changed, so a value in it is at most a few
 * seconds behind what the device said. Forgetting a device takes its row
 * with it (the table cascades); a device moved to another type starts
 * afresh (`DeviceCatalog.retype`).
 */
export class LastReadings {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** What a device last said of each attribute: none for one never heard. */
  of(deviceId: SavedDeviceId): Reading[] {
    return this.#db
      .query<{ key: string; value: string; at: string }, [string]>('SELECT key, value, at FROM device_reading WHERE device_id = ? ORDER BY key')
      .all(deviceId)
      .map((row) => ({ key: row.key, value: JSON.parse(row.value) as Reading['value'], at: row.at }));
  }

  /** Keeps what a device said — each reading's value and when it was said — in one go. One of a device deleted since is skipped. */
  keep(deviceId: SavedDeviceId, readings: readonly Reading[]): void {
    if (!readings.length) return;
    const upsert = this.#db.query(
      'INSERT INTO device_reading (device_id, key, value, at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM device WHERE id = ?) ' +
        'ON CONFLICT (device_id, key) DO UPDATE SET value = excluded.value, at = excluded.at'
    );
    this.#db.transaction(() => {
      for (const reading of readings) upsert.run(deviceId, reading.key, JSON.stringify(reading.value), reading.at, deviceId);
    })();
  }
}
