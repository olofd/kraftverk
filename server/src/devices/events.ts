import type { DeviceEventMessage } from '@kraftverk/holder';
import { MAIN_PART, type EventLevel, type SavedDeviceId, type Value } from '@kraftverk/device-sdk';

import { db } from '../history/db.ts';

/**
 * What devices said happened — an overload trip, a button — kept beside their
 * history and pruned with it (docs/ARCHITECTURE.md §4.5). Only events a
 * device's description declares get this far: the holder checks each one.
 */

export type DeviceEventRecord = {
  id: number;
  deviceId: SavedDeviceId;
  part: string;
  event: string;
  level: EventLevel;
  data: Readonly<Record<string, Value>> | null;
  at: string;
};

type Row = { id: number; device_id: string; part: string; event: string; level: EventLevel; data: string | null; at: string };

const toRecord = (row: Row): DeviceEventRecord => ({
  id: row.id,
  deviceId: row.device_id as SavedDeviceId,
  part: row.part,
  event: row.event,
  level: row.level,
  data: row.data === null ? null : (JSON.parse(row.data) as Record<string, Value>),
  at: row.at,
});

export class EventStore {
  record(deviceId: SavedDeviceId, event: DeviceEventMessage): void {
    db()
      .query('INSERT INTO device_event (device_id, part, event, level, data, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(deviceId, event.part ?? MAIN_PART, event.id, event.level, event.data ? JSON.stringify(event.data) : null, event.at);
  }

  /** A device's most recent events, newest first. */
  recent(deviceId: SavedDeviceId, limit = 100): DeviceEventRecord[] {
    return db().query<Row, [string, number]>('SELECT * FROM device_event WHERE device_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(deviceId, limit).map(toRecord);
  }

  /** Warnings and errors across the devices you have — not those removed — newest first. */
  problems(limit = 100): (DeviceEventRecord & { deviceName: string })[] {
    return db()
      .query<Row & { device_name: string }, [number]>(
        `SELECT device_event.*, device.name AS device_name FROM device_event JOIN device ON device.id = device_event.device_id
         WHERE device_event.level <> 'info' AND device.removed_at IS NULL ORDER BY device_event.at DESC, device_event.id DESC LIMIT ?`
      )
      .all(limit)
      .map((row) => ({ ...toRecord(row), deviceName: row.device_name }));
  }
}
