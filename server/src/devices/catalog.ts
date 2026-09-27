import { randomUUID } from 'node:crypto';

import { savedDeviceId, stationId, type SavedDeviceId, type StationId } from '@kraftverk/device-sdk';

import { db } from '../history/db.ts';

/**
 * The devices you have added.
 *
 * This is a *catalog*, not a scan result. A device exists because you added it
 * and named it, and it keeps existing when it is unplugged, out of range, or
 * its driver is having a bad day — greyed out, with its history intact. The
 * alternative, a list derived from whatever answers right now, means your
 * devices disappear whenever your network hiccups, and charts lose their
 * subject.
 */

export type DeviceRecord = {
  id: SavedDeviceId;
  /** A category, for display. Retired by the catalog migration (step 4), which gives every record a type id. */
  type: string;
  /** Unused since models became device types; kept until the catalog migration (step 4). */
  model: string | null;
  /** The device type's id — or a v1 plugin's, or `core.station`. See `typeIdOf`. */
  driver: string;
  name: string;
  /** Adapter-specific, including `boundId`: the station this device reaches. */
  config: Record<string, unknown>;
  addedAt: string;
};

/** The station a record is bound to, if it has been given one. */
export const boundStation = (record: DeviceRecord): StationId | null =>
  typeof record.config.boundId === 'string' ? stationId(record.config.boundId) : null;

/**
 * Which radio this device is reached over.
 *
 * A property of the device, not of the server: one machine can hold a
 * Bluetooth station and a WiFi one at the same time, and each record says
 * which it is. Null means "not decided yet" — a device saved before it was
 * ever bound — and the server offers it the first transport it has.
 */
export const transportOf = (record: DeviceRecord): 'mqtt' | 'ble' | null =>
  record.config.transport === 'ble' || record.config.transport === 'mqtt'
    ? record.config.transport
    : null;

/**
 * Which device type a record is.
 *
 * Transitional, until the catalog has a type column (docs/ARCHITECTURE.md,
 * step 4): a record keeps its type's id in `driver`. The first stations ever
 * saved say `core.station` there instead, and every one of them is a P280 —
 * the only station the old model list could decode.
 */
export const typeIdOf = (record: Pick<DeviceRecord, 'driver'>, installed: (id: string) => boolean): string | null => {
  if (record.driver === 'core.station') return 'aferiy.p280';
  return installed(record.driver) ? record.driver : null;
};

type Row = {
  id: string;
  /** A category, for display. Retired by the catalog migration (step 4), which gives every record a type id. */
  type: string;
  model: string | null;
  driver: string;
  name: string;
  config: string;
  added_at: string;
};

const toRecord = (row: Row): DeviceRecord => ({
  // The database row is a boundary: this is where a string becomes an identity.
  id: savedDeviceId(row.id),
  type: row.type,
  model: row.model,
  driver: row.driver,
  name: row.name,
  config: JSON.parse(row.config) as Record<string, unknown>,
  addedAt: row.added_at,
});

export class DeviceCatalog {
  list(): DeviceRecord[] {
    return db()
      .query<Row, []>('SELECT * FROM device ORDER BY added_at')
      .all()
      .map(toRecord);
  }

  get(id: SavedDeviceId): DeviceRecord | null {
    const row = db().query<Row, [string]>('SELECT * FROM device WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  find(predicate: (record: DeviceRecord) => boolean): DeviceRecord | null {
    return this.list().find(predicate) ?? null;
  }

  add(input: {
    type: string;
    model?: string | null;
    driver: string;
    name: string;
    config?: Record<string, unknown>;
  }): DeviceRecord {
    const record: DeviceRecord = {
      /*
        Opaque: an id that says what the device is invites code that reads it,
        and what it says can stop being true. Ids already saved keep their old
        form — history is keyed by them (docs/ARCHITECTURE.md §4.5).
      */
      id: savedDeviceId(`d-${randomUUID().replaceAll('-', '').slice(0, 12)}`),
      type: input.type,
      model: input.model ?? null,
      driver: input.driver,
      name: input.name,
      config: input.config ?? {},
      addedAt: new Date().toISOString(),
    };

    db()
      .query('INSERT INTO device (id, type, model, driver, name, config, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        record.id,
        record.type,
        record.model,
        record.driver,
        record.name,
        JSON.stringify(record.config),
        record.addedAt
      );

    return record;
  }

  update(id: SavedDeviceId, changes: Partial<Pick<DeviceRecord, 'name' | 'model' | 'config'>>): DeviceRecord | null {
    const existing = this.get(id);
    if (!existing) return null;

    const next: DeviceRecord = {
      ...existing,
      name: changes.name?.trim() || existing.name,
      model: changes.model === undefined ? existing.model : changes.model,
      config: changes.config ? { ...existing.config, ...changes.config } : existing.config,
    };

    db()
      .query('UPDATE device SET name = ?, model = ?, config = ? WHERE id = ?')
      .run(next.name, next.model, JSON.stringify(next.config), id);

    return next;
  }

  /**
   * Forgets a device.
   *
   * Its samples go too. Keeping orphaned history would mean charts for a thing
   * the user has said they no longer own, and a slow leak of rows nobody can
   * see or delete.
   */
  remove(id: SavedDeviceId): void {
    db().transaction(() => {
      db().query('DELETE FROM device WHERE id = ?').run(id);
      db().query('DELETE FROM sample WHERE device_id = ?').run(id);
    })();
  }
}
