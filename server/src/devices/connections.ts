import { randomBytes } from 'node:crypto';

import type { SavedDeviceId } from '@kraftverk/device-sdk';

import { db, openSecret, sealSecret } from '../history/db.ts';

/**
 * How each device is reached (docs/DATA-MODEL.md §3): one row per way, from
 * one place. The station over Wi-Fi from the server and over Bluetooth from
 * your phone is one device with two connections.
 *
 * A connection names its device type's method, the transport it rides, who
 * holds it — the server, or one phone or browser — and the address that
 * transport knows the device by. Its secrets live beside it, sealed; the ones
 * of a connection an app holds never reach the server at all.
 */

export type ConnectionRecord = {
  id: string;
  deviceId: SavedDeviceId;
  /** One of the device type's connection methods: `wifi`. */
  method: string;
  /** The method's transport, copied here for the address rule: `mqtt`. */
  transport: string;
  /** The client that holds it, or null for the server. */
  heldBy: string | null;
  /** What the transport knows the device by: a MAC, an IP, a browser's handle. */
  address: string;
  /** 0 is preferred; higher numbers are fallbacks. */
  priority: number;
  /** The method's own choices, and the protocol's non-secret credentials. */
  config: Record<string, unknown>;
  createdAt: string;
  lastConnectedAt: string | null;
};

type Row = {
  id: string;
  device_id: string;
  method: string;
  transport: string;
  held_by: string | null;
  address: string;
  priority: number;
  config: string;
  created_at: string;
  last_connected_at: string | null;
};

const toRecord = (row: Row): ConnectionRecord => ({
  id: row.id,
  deviceId: row.device_id as SavedDeviceId,
  method: row.method,
  transport: row.transport,
  heldBy: row.held_by,
  address: row.address,
  priority: row.priority,
  config: JSON.parse(row.config) as Record<string, unknown>,
  createdAt: row.created_at,
  lastConnectedAt: row.last_connected_at,
});

export class ConnectionStore {
  /** A device's connections, preferred first. */
  forDevice(deviceId: SavedDeviceId): ConnectionRecord[] {
    return db()
      .query<Row, [string]>('SELECT * FROM device_connection WHERE device_id = ? ORDER BY priority, created_at')
      .all(deviceId)
      .map(toRecord);
  }

  /** Every connection, grouped by device, each group preferred first: one query for a whole list. */
  byDevice(): Map<SavedDeviceId, ConnectionRecord[]> {
    const grouped = new Map<SavedDeviceId, ConnectionRecord[]>();
    for (const row of db().query<Row, []>('SELECT * FROM device_connection ORDER BY priority, created_at').all()) {
      const record = toRecord(row);
      grouped.set(record.deviceId, [...(grouped.get(record.deviceId) ?? []), record]);
    }
    return grouped;
  }

  get(id: string): ConnectionRecord | null {
    const row = db().query<Row, [string]>('SELECT * FROM device_connection WHERE id = ?').get(id);
    return row ? toRecord(row) : null;
  }

  add(input: {
    deviceId: SavedDeviceId;
    method: string;
    transport: string;
    heldBy: string | null;
    address: string;
    config?: Record<string, unknown>;
    priority?: number;
  }): ConnectionRecord {
    const existing = this.forDevice(input.deviceId);
    const record: ConnectionRecord = {
      id: `c-${randomBytes(6).toString('hex')}`,
      deviceId: input.deviceId,
      method: input.method,
      transport: input.transport,
      heldBy: input.heldBy,
      address: input.address,
      // A new way to reach a device comes after the ones it already has.
      priority: input.priority ?? (existing.length ? Math.max(...existing.map((c) => c.priority)) + 1 : 0),
      config: input.config ?? {},
      createdAt: new Date().toISOString(),
      lastConnectedAt: null,
    };
    db()
      .query(
        'INSERT INTO device_connection (id, device_id, method, transport, held_by, address, priority, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(record.id, record.deviceId, record.method, record.transport, record.heldBy, record.address, record.priority, JSON.stringify(record.config), record.createdAt);
    return record;
  }

  update(id: string, changes: { priority?: number; config?: Record<string, unknown>; address?: string }): ConnectionRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    const next = { ...existing, ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)) };
    db()
      .query('UPDATE device_connection SET priority = ?, config = ?, address = ? WHERE id = ?')
      .run(next.priority, JSON.stringify(next.config), next.address, id);
    return next;
  }

  /** Makes one connection the preferred way, keeping the others in order behind it. */
  prefer(id: string): void {
    const chosen = this.get(id);
    if (!chosen) return;
    const others = this.forDevice(chosen.deviceId).filter((connection) => connection.id !== id);
    db().transaction(() => {
      db().query('UPDATE device_connection SET priority = 0 WHERE id = ?').run(id);
      others.forEach((connection, index) => db().query('UPDATE device_connection SET priority = ? WHERE id = ?').run(index + 1, connection.id));
    })();
  }

  remove(id: string): void {
    db().query('DELETE FROM device_connection WHERE id = ?').run(id);
  }

  /** The device answered through this connection. */
  touch(id: string): void {
    db().query('UPDATE device_connection SET last_connected_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  /**
   * Which device already holds this address on this transport through the
   * server, if any. An exclusive transport's address is one physical thing, so
   * two devices may not both claim it (docs/DATA-MODEL.md §3).
   */
  claimant(transport: string, address: string): { deviceId: SavedDeviceId; connectionId: string } | null {
    const row = db()
      .query<{ id: string; device_id: string }, [string, string]>(
        `SELECT c.id, c.device_id FROM device_connection c JOIN device d ON d.id = c.device_id
         WHERE c.transport = ? AND UPPER(c.address) = UPPER(?) AND c.held_by IS NULL AND d.removed_at IS NULL`
      )
      .get(transport, address);
    return row ? { deviceId: row.device_id as SavedDeviceId, connectionId: row.id } : null;
  }

  // --- secrets -------------------------------------------------------------------

  /** One secret, opened: null when there is none, or it cannot be opened with the key this server has. */
  secret(connectionId: string, field: string): string | null {
    const row = db()
      .query<{ value: string; encrypted: number }, [string, string]>('SELECT value, encrypted FROM connection_secret WHERE connection_id = ? AND field = ?')
      .get(connectionId, field);
    return row ? openSecret(row.value, row.encrypted === 1) : null;
  }

  /** Which secrets a connection has, by field — never their values. */
  secretFields(connectionId: string): string[] {
    return db()
      .query<{ field: string }, [string]>('SELECT field FROM connection_secret WHERE connection_id = ? ORDER BY field')
      .all(connectionId)
      .map((row) => row.field);
  }

  /** The names of every connection's secrets, by connection: one query for a whole list. */
  secretFieldsByConnection(): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const row of db().query<{ connection_id: string; field: string }, []>('SELECT connection_id, field FROM connection_secret ORDER BY field').all()) {
      grouped.set(row.connection_id, [...(grouped.get(row.connection_id) ?? []), row.field]);
    }
    return grouped;
  }

  setSecrets(connectionId: string, values: Record<string, string>): void {
    const upsert = db().query(
      'INSERT INTO connection_secret (connection_id, field, value, encrypted) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (connection_id, field) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted'
    );
    db().transaction(() => {
      for (const [field, value] of Object.entries(values)) {
        const sealed = sealSecret(value);
        upsert.run(connectionId, field, sealed.value, sealed.encrypted ? 1 : 0);
      }
    })();
  }
}
