import type { LinkRecord } from '@kraftverk/api-contract';
import { randomBytes } from 'node:crypto';

import { linkId, linkKindSpec, savedDeviceId, type LinkEnd, type LinkKind, type SavedDeviceId } from '@kraftverk/device-sdk';

import { db } from '../history/db.ts';

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
  all(): LinkRecord[] {
    return db().query<Row, []>('SELECT * FROM device_link ORDER BY created_at').all().map(toRecord);
  }

  get(id: string): LinkRecord | null {
    const row = db().query<Row, [string]>('SELECT * FROM device_link WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  /** Every link a device is either end of. */
  forDevice(deviceId: SavedDeviceId): LinkRecord[] {
    return db()
      .query<Row, [string, string]>('SELECT * FROM device_link WHERE source_device = ? OR target_device = ? ORDER BY created_at')
      .all(deviceId, deviceId)
      .map(toRecord);
  }

  /** Every link whose source is this part of this device, of any kind: what the gateway walks. */
  from(deviceId: SavedDeviceId, part: string): LinkRecord[] {
    return db()
      .query<Row, [string, string]>('SELECT * FROM device_link WHERE source_device = ? AND source_part = ? ORDER BY created_at')
      .all(deviceId, part)
      .map(toRecord);
  }

  /**
   * Records a link. A kind with one target per source replaces what the
   * source part pointed at before: a plug feeds one thing.
   */
  add(input: { kind: LinkKind; source: LinkEnd<SavedDeviceId>; target: LinkEnd<SavedDeviceId> }): LinkRecord {
    if (input.source.device === input.target.device) throw new Error('A device cannot be linked to itself');
    const record: LinkRecord = { id: linkId(`l-${randomBytes(6).toString('hex')}`), ...input, createdAt: new Date().toISOString() };
    db().transaction(() => {
      if (linkKindSpec(input.kind).onePerSource) {
        db().query('DELETE FROM device_link WHERE kind = ? AND source_device = ? AND source_part = ?').run(input.kind, input.source.device, input.source.part);
      } else {
        db()
          .query('DELETE FROM device_link WHERE kind = ? AND source_device = ? AND source_part = ? AND target_device = ? AND target_part = ?')
          .run(input.kind, input.source.device, input.source.part, input.target.device, input.target.part);
      }
      db()
        .query('INSERT INTO device_link (id, kind, source_device, source_part, target_device, target_part, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(record.id, record.kind, record.source.device, record.source.part, record.target.device, record.target.part, record.createdAt);
    })();
    return record;
  }

  remove(id: string): void {
    db().query('DELETE FROM device_link WHERE id = ?').run(id);
  }
}
