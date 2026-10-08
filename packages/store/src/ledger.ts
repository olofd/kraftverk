import type { GatewayLedger, LedgerMark } from '@kraftverk/gateway';

import type { SqlDatabase } from './database.ts';

/**
 * The gateway's memory of each device, in the database: when each part was
 * last switched and each setting last written, and by whom — so a restart is
 * no way around the dwell — and gone with the device when it is deleted.
 */
export const databaseLedger = (db: SqlDatabase): GatewayLedger => {
  const mark = (row: { at: string; by: string } | null): LedgerMark | null => (row ? { at: Date.parse(row.at), by: row.by } : null);
  return {
    lastSwitch: (device, part) =>
      mark(db.query<{ at: string; by: string }, [string, string]>('SELECT switched_at AS at, switched_by AS by FROM device_switch WHERE device_id = ? AND part = ?').get(device, part)),
    switched: (device, part, { at, by }) =>
      void db
        .query(
          'INSERT INTO device_switch (device_id, part, switched_at, switched_by) VALUES (?, ?, ?, ?) ON CONFLICT (device_id, part) DO UPDATE SET switched_at = excluded.switched_at, switched_by = excluded.switched_by'
        )
        .run(device, part, new Date(at).toISOString(), by),
    unswitched: (device, part, before) =>
      void (before
        ? db.query('UPDATE device_switch SET switched_at = ?, switched_by = ? WHERE device_id = ? AND part = ?').run(new Date(before.at).toISOString(), before.by, device, part)
        : db.query('DELETE FROM device_switch WHERE device_id = ? AND part = ?').run(device, part)),
    lastWrite: (device, attribute) =>
      mark(db.query<{ at: string; by: string }, [string, string]>('SELECT written_at AS at, written_by AS by FROM device_write WHERE device_id = ? AND attribute = ?').get(device, attribute)),
    wrote: (device, attribute, { at, by }) =>
      void db
        .query(
          'INSERT INTO device_write (device_id, attribute, written_at, written_by) VALUES (?, ?, ?, ?) ON CONFLICT (device_id, attribute) DO UPDATE SET written_at = excluded.written_at, written_by = excluded.written_by'
        )
        .run(device, attribute, new Date(at).toISOString(), by),
  };
};
