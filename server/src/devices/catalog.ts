import { randomUUID } from 'node:crypto';

import { savedDeviceId, stationId, type SavedDeviceId, type StationId } from '@kraftverk/plugin-sdk';

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

export type DeviceType = 'power-station' | 'smart-plug';

export type DeviceRecord = {
  id: SavedDeviceId;
  type: DeviceType;
  /** Which hardware it is. Decides how it is read; see MODELS. */
  model: string | null;
  /** 'core.station', or a plugin id. */
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
 * Station models, and how far each one is actually trusted.
 *
 * The register map was derived from FOSSiBOT hardware and verified only on a
 * P280, so the picker says so rather than implying they are equal. Someone
 * choosing an untested model should know that before their numbers look odd,
 * not after.
 */
export const STATION_MODELS = [
  { id: 'aferiy-p280', label: 'AFERIY P280', verified: true, note: 'Every setting confirmed on real hardware' },
  { id: 'aferiy-p210', label: 'AFERIY P210', verified: false, note: 'Same stack, untested' },
  { id: 'aferiy-p310', label: 'AFERIY P310', verified: false, note: 'Same stack, untested' },
  { id: 'fossibot-f2400', label: 'FOSSiBOT F2400', verified: false, note: 'AC charging scale differs' },
  { id: 'fossibot-f3600', label: 'FOSSiBOT F3600', verified: false, note: 'Same stack, untested' },
  { id: 'ecoplay-syd2400', label: 'Eco Play SYD2400', verified: false, note: 'Same stack, untested' },
  { id: 'abok-ark3600', label: 'ABOK Power Ark3600', verified: false, note: 'Same stack, untested' },
  { id: 'other', label: 'Something else', verified: false, note: 'Decoded as a P280 until told otherwise' },
] as const;

export const DEFAULT_STATION_MODEL = 'aferiy-p280';

export const modelLabel = (id: string | null): string =>
  STATION_MODELS.find((model) => model.id === id)?.label ?? 'Power station';

type Row = {
  id: string;
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
  type: row.type as DeviceType,
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
    type: DeviceType;
    model?: string | null;
    driver: string;
    name: string;
    config?: Record<string, unknown>;
  }): DeviceRecord {
    const record: DeviceRecord = {
      id: savedDeviceId(`${input.type}:${randomUUID().slice(0, 8)}`),
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
