import type { DeviceStore, SavedDeviceId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * One device's own storage, in `device_kv`.
 *
 * Scoped by the device rather than by the code that writes it: two plugs of
 * the same type each get their own, and forgetting a device takes its store
 * with it (the table cascades).
 */
export function deviceStore(db: SqlDatabase, deviceId: SavedDeviceId): DeviceStore {
  return {
    get: <T>(key: string): T | null => {
      const row = db
        .query<{ value: string }, [string, string]>('SELECT value FROM device_kv WHERE device_id = ? AND key = ?')
        .get(deviceId, key);
      return row ? (JSON.parse(row.value) as T) : null;
    },
    set: (key, value) => {
      db
        .query(
          'INSERT INTO device_kv (device_id, key, value) VALUES (?, ?, ?) ' +
            'ON CONFLICT (device_id, key) DO UPDATE SET value = excluded.value'
        )
        .run(deviceId, key, JSON.stringify(value));
    },
    delete: (key) => {
      db.query('DELETE FROM device_kv WHERE device_id = ? AND key = ?').run(deviceId, key);
    },
  };
}
