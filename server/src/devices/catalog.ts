import { randomUUID } from 'node:crypto';

import { partOf, savedDeviceId, type AttributeSpec, type DescriptionSource, type DeviceDescription, type DeviceInfo, type SavedDeviceId } from '@kraftverk/device-sdk';

import { db } from '../history/db.ts';

/**
 * The devices you have added (docs/DATA-MODEL.md §3).
 *
 * This is a *catalog*, not a scan result. A device exists because you added it
 * and named it, and it keeps existing when it is unplugged or out of range —
 * greyed out, with its history intact. It keeps existing after you remove it,
 * too, until you delete its history on purpose: removing a device is something
 * people do to tidy up, and it must not be the thing that destroys years of
 * measurements (docs/ARCHITECTURE.md, decision 13).
 *
 * How a device is reached is not here: that is its connections
 * (`connections.ts`). What it is, is its type — which never changes.
 */

export type DeviceRecord = {
  id: SavedDeviceId;
  /** The device type: `acme.plug`. Stable forever. */
  typeId: string;
  /** Its own permanent id, read from the device — `acme:AABBCC001122` — or null until it has said. */
  identity: string | null;
  name: string;
  /** The type's own choices for this device: a profile, a location. Never secrets. */
  config: Record<string, unknown>;
  addedAt: string;
  /** When it was removed; its history is kept. Null while it is yours. */
  removedAt: string | null;
  /** What it is — parts, attributes, events — as it was last described: by its type, or by itself. */
  description: DeviceDescription;
  /** Which of the two that was. */
  descriptionSource: DescriptionSource;
  /** What it has said about itself. Null until it has. */
  info: DeviceInfo | null;
};

type Row = {
  id: string;
  type_id: string;
  identity: string | null;
  name: string;
  config: string;
  description: string;
  description_source: DescriptionSource;
  info: string | null;
  added_at: string;
  removed_at: string | null;
};

const toRecord = (row: Row): DeviceRecord => ({
  // The database row is a boundary: this is where a string becomes an identity.
  id: savedDeviceId(row.id),
  typeId: row.type_id,
  identity: row.identity,
  name: row.name,
  config: JSON.parse(row.config) as Record<string, unknown>,
  addedAt: row.added_at,
  removedAt: row.removed_at,
  description: JSON.parse(row.description) as DeviceDescription,
  descriptionSource: row.description_source,
  info: row.info === null ? null : (JSON.parse(row.info) as DeviceInfo),
});

export class DeviceCatalog {
  /** The devices you have: not removed. */
  list(): DeviceRecord[] {
    return db().query<Row, []>('SELECT * FROM device WHERE removed_at IS NULL ORDER BY added_at').all().map(toRecord);
  }

  /** Devices removed and kept, newest first: what can be brought back. */
  removed(): DeviceRecord[] {
    return db().query<Row, []>('SELECT * FROM device WHERE removed_at IS NOT NULL ORDER BY removed_at DESC').all().map(toRecord);
  }

  /** Any device, removed or not. Callers that mean "one you have" check `removedAt`. */
  get(id: SavedDeviceId): DeviceRecord | null {
    const row = db().query<Row, [string]>('SELECT * FROM device WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  /** A device you have, or null — including when it has been removed. */
  active(id: SavedDeviceId): DeviceRecord | null {
    const record = this.get(id);
    return record && !record.removedAt ? record : null;
  }

  /** Who has this identity: the device you have with it, and removed ones that had it. */
  byIdentity(identity: string): { active: DeviceRecord | null; removed: DeviceRecord[] } {
    const rows = db().query<Row, [string]>('SELECT * FROM device WHERE identity = ? ORDER BY removed_at DESC').all(identity).map(toRecord);
    return { active: rows.find((record) => !record.removedAt) ?? null, removed: rows.filter((record) => record.removedAt) };
  }

  add(input: { typeId: string; name: string; description: DeviceDescription; identity?: string | null; config?: Record<string, unknown> }): DeviceRecord {
    const record: DeviceRecord = {
      /*
        Opaque: an id that says what the device is invites code that reads it,
        and what it says can stop being true. Ids already saved keep their old
        form — history is keyed by them (docs/DATA-MODEL.md §3).
      */
      id: savedDeviceId(`d-${randomUUID().replaceAll('-', '').slice(0, 12)}`),
      typeId: input.typeId,
      identity: input.identity ?? null,
      name: input.name,
      config: input.config ?? {},
      addedAt: new Date().toISOString(),
      removedAt: null,
      description: input.description,
      // Its type's word, until it says more itself.
      descriptionSource: 'type',
      info: null,
    };
    db().transaction(() => {
      db()
        .query('INSERT INTO device (id, type_id, identity, name, config, description, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, record.typeId, record.identity, record.name, JSON.stringify(record.config), JSON.stringify(record.description), record.addedAt);
      this.#recordAttributes(record.id, record.description, record.addedAt);
    })();
    return record;
  }

  /**
   * Keeps what a device is and has said about itself, writing only what
   * changed, and records any attribute it has not had before. Returns whether
   * its description changed — a pack plugged in, a firmware that says more.
   */
  describe(id: SavedDeviceId, description: DeviceDescription, info: DeviceInfo | null, source: DescriptionSource): boolean {
    const row = db()
      .query<{ description: string; description_source: DescriptionSource; info: string | null }, [string]>('SELECT description, description_source, info FROM device WHERE id = ?')
      .get(id);
    if (!row) return false; // removed since it was opened: nothing to describe
    const json = JSON.stringify(description);
    const changed = row.description !== json;
    // Information a device has not given is not information it lost.
    const infoJson = info ? JSON.stringify(info) : null;
    db().transaction(() => {
      if (source !== row.description_source) db().query('UPDATE device SET description_source = ? WHERE id = ?').run(source, id);
      if (changed) {
        db().query('UPDATE device SET description = ? WHERE id = ?').run(json, id);
        this.#recordAttributes(id, description, new Date().toISOString());
      }
      if (infoJson !== null && infoJson !== row.info) db().query('UPDATE device SET info = ? WHERE id = ?').run(infoJson, id);
    })();
    return changed;
  }

  /** Every attribute the device has ever had, as last described: what its history is labelled by. */
  attributes(id: SavedDeviceId): AttributeSpec[] {
    return db()
      .query<{ spec: string }, [string]>('SELECT spec FROM device_attribute WHERE device_id = ? ORDER BY first_seen, key')
      .all(id)
      .map((row) => JSON.parse(row.spec) as AttributeSpec);
  }

  #recordAttributes(id: SavedDeviceId, description: DeviceDescription, at: string): void {
    const upsert = db().query(
      `INSERT INTO device_attribute (device_id, key, part, spec, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, key) DO UPDATE SET part = excluded.part, spec = excluded.spec, last_seen = excluded.last_seen`
    );
    for (const attribute of description.attributes) upsert.run(id, attribute.key, partOf(attribute), JSON.stringify(attribute), at, at);
  }

  update(id: SavedDeviceId, changes: { name?: string; config?: Record<string, unknown>; identity?: string | null }): DeviceRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next: DeviceRecord = {
      ...existing,
      name: changes.name?.trim() || existing.name,
      config: changes.config ?? existing.config,
      identity: changes.identity === undefined ? existing.identity : changes.identity,
    };
    db()
      .query('UPDATE device SET name = ?, config = ?, identity = ? WHERE id = ?')
      .run(next.name, JSON.stringify(next.config), next.identity, id);
    return next;
  }

  /**
   * Removes a device, keeping its history.
   *
   * Its connections go — with their secrets, which frees the addresses for
   * something else — and so do its links, which are facts about a house it is
   * no longer part of. Its samples, its store and its identity stay, so adding
   * the same device again can bring it all back.
   */
  remove(id: SavedDeviceId): DeviceRecord | null {
    const record = this.active(id);
    if (!record) return null;
    const removedAt = new Date().toISOString();
    db().transaction(() => {
      db().query('DELETE FROM device_connection WHERE device_id = ?').run(id);
      db().query('DELETE FROM device_link WHERE source_device = ? OR target_device = ?').run(id, id);
      db().query('UPDATE device SET removed_at = ? WHERE id = ?').run(removedAt, id);
    })();
    return { ...record, removedAt };
  }

  /** Brings a removed device back, with its history. It needs a connection again. */
  restore(id: SavedDeviceId): DeviceRecord | null {
    const record = this.get(id);
    if (!record?.removedAt) return null;
    if (record.identity && this.byIdentity(record.identity).active) {
      throw new Error('You already have that device');
    }
    db().query('UPDATE device SET removed_at = NULL WHERE id = ?').run(id);
    return { ...record, removedAt: null };
  }

  /** Everything a device's session keeps between runs, by key. */
  storeOf(id: SavedDeviceId): Record<string, unknown> {
    const rows = db().query<{ key: string; value: string }, [string]>('SELECT key, value FROM device_kv WHERE device_id = ? ORDER BY key').all(id);
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]));
  }

  /**
   * Deletes a removed device and everything it recorded. Irreversible, and
   * only ever asked for explicitly: samples first, then the row, whose store,
   * connections and links go with it.
   */
  deleteForever(id: SavedDeviceId): { samples: number } {
    let samples = 0;
    db().transaction(() => {
      samples = db().query('DELETE FROM sample WHERE device_id = ?').run(id).changes;
      db().query('DELETE FROM device WHERE id = ?').run(id);
    })();
    return { samples };
  }
}
