import type { LinkRecord } from '@kraftverk/api-contract';

import { linkId, linkKindSpec, savedDeviceId, type LinkEnd, type LinkKind, type SavedDeviceId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';
import { newId } from '@kraftverk/device-sdk';

/**
 * Links: physical facts between parts of two devices, recorded once and read
 * by everything that needs them (docs/ARCHITECTURE.md §4.4) — the gateway,
 * which walks every link from a part it commands and holds the command to the
 * target's evidence; the energy view; any number of automations.
 */

export type { LinkRecord };

type Row = { id: string; kind: string; source_device: string; source_part: string; target_device: string; target_part: string; created_at: string };

const toRecord = (row: Row): LinkRecord => ({
  id: linkId(row.id),
  kind: row.kind as LinkKind,
  source: { device: savedDeviceId(row.source_device), part: row.source_part },
  target: { device: savedDeviceId(row.target_device), part: row.target_part },
  createdAt: row.created_at,
});

export class LinkStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  all(): LinkRecord[] {
    return this.#db.query<Row, []>('SELECT * FROM device_link ORDER BY created_at').all().map(toRecord);
  }

  get(id: string): LinkRecord | null {
    const row = this.#db.query<Row, [string]>('SELECT * FROM device_link WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  /** Every link a device is either end of. */
  forDevice(deviceId: SavedDeviceId): LinkRecord[] {
    return this.#db
      .query<Row, [string, string]>('SELECT * FROM device_link WHERE source_device = ? OR target_device = ? ORDER BY created_at')
      .all(deviceId, deviceId)
      .map(toRecord);
  }

  /** Every link whose source is this part of this device, of any kind: what the gateway walks. */
  from(deviceId: SavedDeviceId, part: string): LinkRecord[] {
    return this.#db
      .query<Row, [string, string]>('SELECT * FROM device_link WHERE source_device = ? AND source_part = ? ORDER BY created_at')
      .all(deviceId, part)
      .map(toRecord);
  }

  /**
   * Records a link. A kind with one target per source replaces what the
   * source part pointed at before: a plug feeds one thing. The row says which
   * it is, and a unique index holds it (schema.ts).
   */
  add(input: { kind: LinkKind; source: LinkEnd<SavedDeviceId>; target: LinkEnd<SavedDeviceId> }): LinkRecord {
    if (input.source.device === input.target.device) throw new Error('A device cannot be linked to itself');
    const record: LinkRecord = { id: linkId(newId('l')), ...input, createdAt: new Date().toISOString() };
    const onePerSource = linkKindSpec(input.kind).onePerSource === true;
    this.#db.transaction(() => {
      if (onePerSource) {
        this.#db.query('DELETE FROM device_link WHERE kind = ? AND source_device = ? AND source_part = ?').run(input.kind, input.source.device, input.source.part);
      } else {
        this.#db
          .query('DELETE FROM device_link WHERE kind = ? AND source_device = ? AND source_part = ? AND target_device = ? AND target_part = ?')
          .run(input.kind, input.source.device, input.source.part, input.target.device, input.target.part);
      }
      this.#db
        .query('INSERT INTO device_link (id, kind, source_device, source_part, target_device, target_part, one_per_source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, record.kind, record.source.device, record.source.part, record.target.device, record.target.part, onePerSource ? 1 : 0, record.createdAt);
    })();
    return record;
  }

  /** One end of a link moved to another part of its device: the device's type changed, and the part is called otherwise. */
  repoint(id: string, end: 'source' | 'target', part: string): void {
    this.#db.query(`UPDATE device_link SET ${end === 'source' ? 'source_part' : 'target_part'} = ? WHERE id = ?`).run(part, id);
  }

  remove(id: string): void {
    this.#db.query('DELETE FROM device_link WHERE id = ?').run(id);
  }
}
