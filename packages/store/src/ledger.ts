import type { ActorKind } from '@kraftverk/device-sdk';
import type { GatewayLedger, LedgerMark } from '@kraftverk/gateway';

import type { SqlDatabase } from './database.ts';

/**
 * The gateway's memory of each device, in the database: when each part was
 * last switched and each setting last written, and by whom — so a restart is
 * no way around the dwell — and gone with the device when it is deleted.
 */
export const databaseLedger = (db: SqlDatabase): GatewayLedger => {
  type Row = { at: string; by_kind: ActorKind; by_id: string | null; by_name: string };
  const mark = (row: Row | null): LedgerMark | null => (row ? { at: Date.parse(row.at), by: { kind: row.by_kind, id: row.by_id, name: row.by_name } } : null);
  return {
    lastSwitch: (device, part) =>
      mark(db.query<Row, [string, string]>('SELECT switched_at AS at, by_kind, by_id, by_name FROM device_switch WHERE device_id = ? AND part = ?').get(device, part)),
    switched: (device, part, { at, by }) =>
      void db
        .query(
          'INSERT INTO device_switch (device_id, part, switched_at, by_kind, by_id, by_name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, part) DO UPDATE SET switched_at = excluded.switched_at, by_kind = excluded.by_kind, by_id = excluded.by_id, by_name = excluded.by_name'
        )
        .run(device, part, new Date(at).toISOString(), by.kind, by.id, by.name),
    unswitched: (device, part, before) =>
      void (before
        ? db
            .query('UPDATE device_switch SET switched_at = ?, by_kind = ?, by_id = ?, by_name = ? WHERE device_id = ? AND part = ?')
            .run(new Date(before.at).toISOString(), before.by.kind, before.by.id, before.by.name, device, part)
        : db.query('DELETE FROM device_switch WHERE device_id = ? AND part = ?').run(device, part)),
    lastWrite: (device, attribute) =>
      mark(db.query<Row, [string, string]>('SELECT written_at AS at, by_kind, by_id, by_name FROM device_write WHERE device_id = ? AND attribute = ?').get(device, attribute)),
    wrote: (device, attribute, { at, by }) =>
      void db
        .query(
          'INSERT INTO device_write (device_id, attribute, written_at, by_kind, by_id, by_name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, attribute) DO UPDATE SET written_at = excluded.written_at, by_kind = excluded.by_kind, by_id = excluded.by_id, by_name = excluded.by_name'
        )
        .run(device, attribute, new Date(at).toISOString(), by.kind, by.id, by.name),
  };
};
