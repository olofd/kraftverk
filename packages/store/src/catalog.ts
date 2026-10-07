
import { KEY, keyFrom } from '@kraftverk/device-sdk';
import { partOf, savedDeviceId, type AttributeSpec, type DescriptionSource, type DeviceDescription, type DeviceInfo, type SavedDeviceId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';
import { newId } from '@kraftverk/device-sdk';

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
  /** Its name in configuration: `garage-station`, what a file and an import know it by (docs/CONFIG.md). */
  key: string;
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
  /** When its owner paused it: kept, and not reached, until resumed. Null while it is not paused. */
  pausedAt: string | null;
  /** What it is — parts, attributes, events — as it was last described: by its type, or by itself. */
  description: DeviceDescription;
  /** Which of the two that was. */
  descriptionSource: DescriptionSource;
  /** What it has said about itself. Null until it has. */
  info: DeviceInfo | null;
  /** Which picture it shows, its owner's pick: `type:N`, one day `own:<id>`. Null: its type's first. */
  picture: string | null;
};

type Row = {
  id: string;
  key: string;
  type_id: string;
  identity: string | null;
  name: string;
  config: string;
  description: string;
  description_source: DescriptionSource;
  info: string | null;
  picture: string | null;
  added_at: string;
  paused_at: string | null;
  removed_at: string | null;
};

const toRecord = (row: Row): DeviceRecord => ({
  // The database row is a boundary: this is where a string becomes an identity.
  id: savedDeviceId(row.id),
  key: row.key,
  typeId: row.type_id,
  identity: row.identity,
  name: row.name,
  config: JSON.parse(row.config) as Record<string, unknown>,
  addedAt: row.added_at,
  removedAt: row.removed_at,
  pausedAt: row.paused_at,
  description: JSON.parse(row.description) as DeviceDescription,
  descriptionSource: row.description_source,
  info: row.info === null ? null : (JSON.parse(row.info) as DeviceInfo),
  picture: row.picture,
});

export class DeviceCatalog {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** The devices you have: not removed. */
  list(): DeviceRecord[] {
    return this.#db.query<Row, []>('SELECT * FROM device WHERE removed_at IS NULL ORDER BY added_at, rowid').all().map(toRecord);
  }

  /** Devices removed and kept, newest first: what can be brought back. */
  removed(): DeviceRecord[] {
    return this.#db.query<Row, []>('SELECT * FROM device WHERE removed_at IS NOT NULL ORDER BY removed_at DESC').all().map(toRecord);
  }

  /** Any device, removed or not. Callers that mean "one you have" check `removedAt`. */
  get(id: SavedDeviceId): DeviceRecord | null {
    const row = this.#db.query<Row, [string]>('SELECT * FROM device WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  /** A device you have, or null — including when it has been removed. */
  active(id: SavedDeviceId): DeviceRecord | null {
    const record = this.get(id);
    return record && !record.removedAt ? record : null;
  }

  /** Who has this identity: the device you have with it, and removed ones that had it. */
  byIdentity(identity: string): { active: DeviceRecord | null; removed: DeviceRecord[] } {
    const rows = this.#db.query<Row, [string]>('SELECT * FROM device WHERE identity = ? ORDER BY removed_at DESC').all(identity).map(toRecord);
    return { active: rows.find((record) => !record.removedAt) ?? null, removed: rows.filter((record) => record.removedAt) };
  }

  /** The device you have known by this key, or null. */
  byKey(key: string): DeviceRecord | null {
    const row = this.#db.query<Row, [string]>('SELECT * FROM device WHERE key = ? AND removed_at IS NULL').get(key);
    return row ? toRecord(row) : null;
  }

  /** Whether a device you have is known by this key. */
  keyTaken(key: string, except?: SavedDeviceId): boolean {
    return this.#db.query<{ id: string }, [string]>('SELECT id FROM device WHERE key = ? AND removed_at IS NULL').all(key).some((row) => row.id !== except);
  }

  add(input: { typeId: string; name: string; description: DeviceDescription; identity?: string | null; config?: Record<string, unknown>; key?: string }): DeviceRecord {
    if (input.key !== undefined && (!KEY.test(input.key) || this.keyTaken(input.key))) throw new Error(`"${input.key}" is not a free key: lowercase letters, digits and dashes, and not another device's`);
    const record: DeviceRecord = {
      /*
        Opaque: an id that says what the device is invites code that reads it,
        and what it says can stop being true. Ids already saved keep their old
        form — history is keyed by them (docs/DATA-MODEL.md §3).
      */
      id: savedDeviceId(newId('d')),
      // Made from its name unless given: a file's key, kept as the file has it.
      key: input.key ?? keyFrom(input.name, (key) => this.keyTaken(key), 'device'),
      typeId: input.typeId,
      identity: input.identity ?? null,
      pausedAt: null,
      name: input.name,
      config: input.config ?? {},
      addedAt: new Date().toISOString(),
      removedAt: null,
      description: input.description,
      // Its type's word, until it says more itself.
      descriptionSource: 'type',
      info: null,
      picture: null,
    };
    this.#db.transaction(() => {
      this.#db
        .query('INSERT INTO device (id, key, type_id, identity, name, config, description, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, record.key, record.typeId, record.identity, record.name, JSON.stringify(record.config), JSON.stringify(record.description), record.addedAt);
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
    const row = this.#db
      .query<{ description: string; description_source: DescriptionSource; info: string | null }, [string]>('SELECT description, description_source, info FROM device WHERE id = ?')
      .get(id);
    if (!row) return false; // removed since it was opened: nothing to describe
    const json = JSON.stringify(description);
    const changed = row.description !== json;
    // Information a device has not given is not information it lost.
    const infoJson = info ? JSON.stringify(info) : null;
    this.#db.transaction(() => {
      if (source !== row.description_source) this.#db.query('UPDATE device SET description_source = ? WHERE id = ?').run(source, id);
      if (changed) {
        this.#db.query('UPDATE device SET description = ? WHERE id = ?').run(json, id);
        this.#recordAttributes(id, description, new Date().toISOString());
      }
      if (infoJson !== null && infoJson !== row.info) this.#db.query('UPDATE device SET info = ? WHERE id = ?').run(infoJson, id);
    })();
    return changed;
  }

  /**
   * Keeps a device as another home has it, by that home's id: an app holding
   * a connection to a server's device keeps the device as the server does
   * (docs/PLAN-SHARED-CORE.md, phase 6). Added, or brought up to what it is
   * there; what this database keeps of its own for it — its store, the
   * gateway's memory of it — stays.
   */
  mirror(record: DeviceRecord): void {
    const at = new Date().toISOString();
    this.#db.transaction(() => {
      this.#db
        .query(
          `INSERT INTO device (id, key, type_id, identity, name, config, description, description_source, info, picture, added_at, paused_at, removed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET key = excluded.key, identity = excluded.identity, name = excluded.name, config = excluded.config,
             description = excluded.description, description_source = excluded.description_source, info = excluded.info,
             picture = excluded.picture, paused_at = excluded.paused_at, removed_at = excluded.removed_at`
        )
        .run(
          record.id,
          record.key,
          record.typeId,
          record.identity,
          record.name,
          JSON.stringify(record.config),
          JSON.stringify(record.description),
          record.descriptionSource,
          record.info === null ? null : JSON.stringify(record.info),
          record.picture,
          record.addedAt,
          record.pausedAt,
          record.removedAt
        );
      this.#recordAttributes(record.id, record.description, at);
    })();
  }

  /** Every attribute the device has ever had, as last described: what its history is labelled by. */
  attributes(id: SavedDeviceId): AttributeSpec[] {
    return this.#db
      .query<{ spec: string }, [string]>('SELECT spec FROM device_attribute WHERE device_id = ? ORDER BY first_seen, key')
      .all(id)
      .map((row) => JSON.parse(row.spec) as AttributeSpec);
  }

  #recordAttributes(id: SavedDeviceId, description: DeviceDescription, at: string): void {
    const upsert = this.#db.query(
      `INSERT INTO device_attribute (device_id, key, part, spec, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, key) DO UPDATE SET part = excluded.part, spec = excluded.spec, last_seen = excluded.last_seen`
    );
    for (const attribute of description.attributes) upsert.run(id, attribute.key, partOf(attribute), JSON.stringify(attribute), at, at);
  }

  update(id: SavedDeviceId, changes: { name?: string; config?: Record<string, unknown>; identity?: string | null; key?: string }): DeviceRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (changes.key !== undefined && changes.key !== existing.key && (!KEY.test(changes.key) || this.keyTaken(changes.key, id))) {
      throw new Error(`"${changes.key}" is not a free key: lowercase letters, digits and dashes, and not another device's`);
    }
    const next: DeviceRecord = {
      ...existing,
      key: changes.key ?? existing.key,
      name: changes.name?.trim() || existing.name,
      config: changes.config ?? existing.config,
      identity: changes.identity === undefined ? existing.identity : changes.identity,
    };
    this.#db
      .query('UPDATE device SET key = ?, name = ?, config = ?, identity = ? WHERE id = ?')
      .run(next.key, next.name, JSON.stringify(next.config), next.identity, id);
    return next;
  }

  /**
   * What a device is now, when its type changed (docs/PLAN-ZIGBEE.md §2.1):
   * its type, its description and config, the attributes it had re-keyed as
   * its history was, and what its old type kept for it cleared. Run in the
   * caller's transaction, with `HistoryStore.rekey`.
   */
  retype(id: SavedDeviceId, to: { typeId: string; description: DeviceDescription; config: Record<string, unknown>; keys: readonly { from: string; to: string; part: string }[] }): void {
    const parked = (index: number) => `\u0000moving:${index}`;
    to.keys.forEach((move, index) => this.#db.query('UPDATE device_attribute SET key = ? WHERE device_id = ? AND key = ?').run(parked(index), id, move.from));
    // Its spec says its key and part too: moved with them, so what its history is labelled by is read back under its new key.
    to.keys.forEach((move, index) =>
      this.#db
        .query("UPDATE OR REPLACE device_attribute SET key = ?, part = ?, spec = json_set(spec, '$.key', ?, '$.part', ?) WHERE device_id = ? AND key = ?")
        .run(move.to, move.part, move.to, move.part, id, parked(index))
    );
    this.#db
      .query("UPDATE device SET type_id = ?, description = ?, description_source = 'type', config = ? WHERE id = ?")
      .run(to.typeId, JSON.stringify(to.description), JSON.stringify(to.config), id);
    this.#recordAttributes(id, to.description, new Date().toISOString());
    this.#db.query('DELETE FROM device_kv WHERE device_id = ?').run(id);
    // What it last said was said as the type it was: its new type's session says again.
    this.#db.query('DELETE FROM device_reading WHERE device_id = ?').run(id);
  }

  /** Which picture it shows: its owner's pick, or null for its type's first. */
  setPicture(id: SavedDeviceId, picture: string | null): DeviceRecord | null {
    this.#db.query('UPDATE device SET picture = ? WHERE id = ?').run(picture, id);
    return this.get(id);
  }

  /** Pauses a device — kept, and not reached, until resumed — or resumes it. */
  setPaused(id: SavedDeviceId, paused: boolean): DeviceRecord | null {
    this.#db.query('UPDATE device SET paused_at = ? WHERE id = ?').run(paused ? new Date().toISOString() : null, id);
    return this.get(id);
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
    this.#db.transaction(() => {
      this.#db.query('DELETE FROM device_connection WHERE device_id = ?').run(id);
      this.#db.query('DELETE FROM device_link WHERE source_device = ? OR target_device = ?').run(id, id);
      this.#db.query('UPDATE device SET removed_at = ? WHERE id = ?').run(removedAt, id);
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
    // Its key back, unless a device you have has it since: then one made from its name.
    const key = this.keyTaken(record.key) ? keyFrom(record.name, (taken) => this.keyTaken(taken), 'device') : record.key;
    this.#db.query('UPDATE device SET removed_at = NULL, key = ? WHERE id = ?').run(key, id);
    return { ...record, key, removedAt: null };
  }

  /** Everything a device's session keeps between runs, by key. */
  storeOf(id: SavedDeviceId): Record<string, unknown> {
    const rows = this.#db.query<{ key: string; value: string }, [string]>('SELECT key, value FROM device_kv WHERE device_id = ? ORDER BY key').all(id);
    return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value) as unknown]));
  }

  /**
   * Deletes a removed device and everything it recorded. Irreversible, and
   * only ever asked for explicitly: samples first, then the row, whose store,
   * connections and links go with it.
   */
  deleteForever(id: SavedDeviceId): { samples: number } {
    let samples = 0;
    this.#db.transaction(() => {
      samples = this.#db.query('DELETE FROM sample WHERE device_id = ?').run(id).changes;
      this.#db.query('DELETE FROM device WHERE id = ?').run(id);
    })();
    return { samples };
  }
}
