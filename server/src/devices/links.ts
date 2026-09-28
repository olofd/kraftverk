import type { LinkRecord } from '@kraftverk/api-contract';
import { randomBytes } from 'node:crypto';

import { LINK_KINDS, type LinkKind, type SavedDeviceId } from '@kraftverk/device-sdk';

import { db } from '../history/db.ts';

/**
 * Links: physical facts between two devices, recorded once and read by
 * everything that needs them (docs/ARCHITECTURE.md §4.4) — the gateway, which
 * verifies a switch of a plug that `feeds` a station against the station's own
 * AC input; the energy view; any number of automations.
 */

export type { LinkRecord };

type Row = { id: string; kind: string; source_id: string; target_id: string; created_at: string };

const toRecord = (row: Row): LinkRecord => ({
  id: row.id,
  kind: row.kind as LinkKind,
  sourceId: row.source_id as SavedDeviceId,
  targetId: row.target_id as SavedDeviceId,
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
      .query<Row, [string, string]>('SELECT * FROM device_link WHERE source_id = ? OR target_id = ? ORDER BY created_at')
      .all(deviceId, deviceId)
      .map(toRecord);
  }

  /** What a device feeds, when it feeds anything: the one target of its `kind` link. */
  targetOf(kind: LinkKind, sourceId: SavedDeviceId): SavedDeviceId | null {
    return (
      (db().query<{ target_id: string }, [string, string]>('SELECT target_id FROM device_link WHERE kind = ? AND source_id = ?').get(kind, sourceId)
        ?.target_id as SavedDeviceId | undefined) ?? null
    );
  }

  /**
   * Records a link. A kind with one target per source replaces what the source
   * pointed at before: a plug feeds one thing.
   */
  add(input: { kind: LinkKind; sourceId: SavedDeviceId; targetId: SavedDeviceId }): LinkRecord {
    if (input.sourceId === input.targetId) throw new Error('A device cannot be linked to itself');
    const record: LinkRecord = { id: `l-${randomBytes(6).toString('hex')}`, ...input, createdAt: new Date().toISOString() };
    db().transaction(() => {
      if (LINK_KINDS[input.kind].onePerSource) {
        db().query('DELETE FROM device_link WHERE kind = ? AND source_id = ?').run(input.kind, input.sourceId);
      }
      db()
        .query('INSERT INTO device_link (id, kind, source_id, target_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(record.id, record.kind, record.sourceId, record.targetId, record.createdAt);
    })();
    return record;
  }

  remove(id: string): void {
    db().query('DELETE FROM device_link WHERE id = ?').run(id);
  }
}
