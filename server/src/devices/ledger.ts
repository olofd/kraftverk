import type { GatewayLedger } from '@kraftverk/gateway';

import { db } from '../history/db.ts';

/**
 * The gateway's memory of each device, in the database: when each part was
 * last switched and each setting last written — so a restart is no way around
 * the dwell — and gone with the device when it is deleted.
 */
export const databaseLedger = (): GatewayLedger => {
  const at = (iso: string | undefined | null) => (iso ? Date.parse(iso) : null);
  return {
    lastSwitch: (device, part) =>
      at(db().query<{ switched_at: string }, [string, string]>('SELECT switched_at FROM device_switch WHERE device_id = ? AND part = ?').get(device, part)?.switched_at),
    switched: (device, part, when) =>
      void db()
        .query('INSERT INTO device_switch (device_id, part, switched_at) VALUES (?, ?, ?) ON CONFLICT (device_id, part) DO UPDATE SET switched_at = excluded.switched_at')
        .run(device, part, new Date(when).toISOString()),
    lastWrite: (device, attribute) =>
      at(db().query<{ written_at: string }, [string, string]>('SELECT written_at FROM device_write WHERE device_id = ? AND attribute = ?').get(device, attribute)?.written_at),
    wrote: (device, attribute, when) =>
      void db()
        .query('INSERT INTO device_write (device_id, attribute, written_at) VALUES (?, ?, ?) ON CONFLICT (device_id, attribute) DO UPDATE SET written_at = excluded.written_at')
        .run(device, attribute, new Date(when).toISOString()),
  };
};
