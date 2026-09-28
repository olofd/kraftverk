import { randomBytes } from 'node:crypto';

import type { Db } from '../db.ts';

/**
 * Migration 7: devices are reached through connections (docs/DATA-MODEL.md §5).
 *
 * What moves where:
 *
 * - `device.driver`, `.type` and `.model` become `device.type_id`. The first
 *   stations ever saved say `core.station`, and every one of them is a P280.
 * - A station's `config.transport` and `.boundId` become one `device_connection`
 *   — Wi-Fi through the broker, or Bluetooth from the server — and its MAC its
 *   `identity`, the id it names itself by.
 * - A plug set up under the old plugin system becomes an ordinary device: an
 *   ATORCH S1W, or a generic Tuya plug for the generic profile, with its
 *   address and device id as its connection and its local key as that
 *   connection's secret — copied exactly as it was sealed, so it opens with the
 *   same KRAFTVERK_SECRET_KEY. Its store comes too.
 * - The grid relay's pairing becomes a `feeds` link from that plug to the
 *   station, and the gateway's memory of the plug's last switch moves to the
 *   plug's own device id.
 * - A saved *simulated* plug is removed, with its history and a line in the
 *   audit timeline: simulators are no longer devices — every type has one.
 * - The plugin tables go.
 *
 * Nothing else is deleted. Removing a device from here on keeps its history
 * (`removed_at`), and a device two old records both claimed keeps its identity
 * on the older one; the newer is left with no connection, as the old code left
 * it with no link, and the audit timeline says so.
 */

export const SQL = `
  CREATE TABLE client (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    platform     TEXT NOT NULL,
    transports   TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  );
  ALTER TABLE sessions ADD COLUMN client_id TEXT REFERENCES client (id) ON DELETE SET NULL;

  ALTER TABLE device ADD COLUMN type_id TEXT;
  ALTER TABLE device ADD COLUMN identity TEXT;
  ALTER TABLE device ADD COLUMN removed_at TEXT;

  CREATE TABLE device_connection (
    id                TEXT PRIMARY KEY,
    device_id         TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    method            TEXT NOT NULL,
    transport         TEXT NOT NULL,
    held_by           TEXT REFERENCES client (id) ON DELETE CASCADE,
    address           TEXT NOT NULL,
    priority          INTEGER NOT NULL DEFAULT 0,
    config            TEXT NOT NULL DEFAULT '{}',
    created_at        TEXT NOT NULL,
    last_connected_at TEXT
  );
  CREATE UNIQUE INDEX device_connection_once ON device_connection (device_id, method, IFNULL(held_by, 'server'));
  CREATE INDEX device_connection_address ON device_connection (transport, address);

  CREATE TABLE connection_secret (
    connection_id TEXT NOT NULL REFERENCES device_connection (id) ON DELETE CASCADE,
    field         TEXT NOT NULL,
    value         TEXT NOT NULL,
    encrypted     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (connection_id, field)
  );

  CREATE TABLE device_link (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    source_id  TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    target_id  TEXT NOT NULL REFERENCES device (id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    CHECK (source_id <> target_id)
  );
  CREATE UNIQUE INDEX device_link_one_per_source ON device_link (kind, source_id);
`;

const TUYA_PLUGIN = 'com.tuya-local.grid-relay';
const FAKE_PLUGIN = 'dev.kraftverk.fake-grid-relay';
const RELAY_STATION_KEY = 'gridRelay.stationDeviceId';

const id = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`;

type OldDevice = { id: string; type: string; model: string | null; driver: string; name: string; config: string; added_at: string };

const parse = (json: string | null | undefined): Record<string, unknown> => {
  try {
    const value = JSON.parse(json ?? '{}') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const macOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/[:\-\s]/g, '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(hex) ? hex : null;
};

/** The pieces of an object that are set, as JSON. */
const compact = (values: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== '')));

export function run(handle: Db): void {
  const now = new Date().toISOString();
  const notes: string[] = [];
  const audit = (kind: string, resource: string | null, summary: string, detail?: unknown) =>
    handle
      .query('INSERT INTO audit (at, kind, actor, resource, summary, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(now, kind, 'migration 7', resource, summary, detail === undefined ? null : JSON.stringify(detail));

  const devices = handle.query<OldDevice, []>('SELECT id, type, model, driver, name, config, added_at FROM device ORDER BY added_at').all();
  const pluginConfig = (plugin: string) =>
    parse(handle.query<{ json: string }, [string]>('SELECT json FROM plugin_config WHERE plugin_id = ?').get(plugin)?.json);
  const identities = new Set<string>();
  const claimIdentity = (identity: string, device: OldDevice): string | null => {
    if (identities.has(identity)) {
      notes.push(`"${device.name}" names the same device as an older one, so it was left without a connection`);
      audit('migration.duplicate', device.id, `"${device.name}" names ${identity}, which an older device already does; it was left without a way to reach it`);
      return null;
    }
    identities.add(identity);
    return identity;
  };
  const addConnection = (deviceId: string, connection: { method: string; transport: string; address: string; config?: Record<string, unknown> }) => {
    const connectionId = id('c');
    handle
      .query('INSERT INTO device_connection (id, device_id, method, transport, held_by, address, priority, config, created_at) VALUES (?, ?, ?, ?, NULL, ?, 0, ?, ?)')
      .run(connectionId, deviceId, connection.method, connection.transport, connection.address, compact(connection.config ?? {}), now);
    return connectionId;
  };
  const setDevice = (deviceId: string, typeId: string, identity: string | null, config: string) =>
    handle.query('UPDATE device SET type_id = ?, identity = ?, config = ? WHERE id = ?').run(typeId, identity, config, deviceId);

  /** The device each plugin became, for the pairing and the gateway's memory. */
  const fromPlugin = new Map<string, string>();

  for (const device of devices) {
    const config = parse(device.config);

    if (device.driver === 'core.station' || device.driver === 'aferiy.p280' || (device.type === 'power-station' && device.driver !== TUYA_PLUGIN)) {
      const mac = macOf(config.boundId);
      const identity = mac ? claimIdentity(`sydpower:${mac}`, device) : null;
      setDevice(device.id, 'aferiy.p280', identity, '{}');
      if (mac && identity) {
        const bluetooth = config.transport === 'ble';
        addConnection(device.id, { method: bluetooth ? 'bluetooth' : 'wifi', transport: bluetooth ? 'ble' : 'mqtt', address: mac });
      } else if (!mac) {
        notes.push(`"${device.name}" had no station chosen, so it has no way to reach it yet`);
      }
      continue;
    }

    if (device.driver === TUYA_PLUGIN) {
      const plugin = pluginConfig(TUYA_PLUGIN);
      const generic = plugin.profile === 'generic-tuya-plug';
      const typeId = generic ? 'tuya.plug' : 'atorch.s1w';
      const deviceConfig = compact({
        profile: generic ? 'generic-tuya-plug' : 'atorch-s1',
        relayDp: typeof plugin.relayDp === 'number' ? plugin.relayDp : undefined,
        bootBehaviour: plugin.bootBehaviour,
        pollSeconds: plugin.pollSeconds,
      });
      const deviceId = typeof plugin.deviceId === 'string' ? plugin.deviceId : null;
      const host = typeof plugin.host === 'string' ? plugin.host : null;
      // One configuration per plugin, so only the first device the plugin provided has one.
      const first = !fromPlugin.has(TUYA_PLUGIN);
      const identity = first && deviceId ? claimIdentity(`tuya-local:${deviceId}`, device) : null;
      setDevice(device.id, typeId, identity, deviceConfig);

      if (first && identity && host) {
        const connectionId = addConnection(device.id, {
          method: 'lan',
          transport: 'lan',
          address: host,
          config: { deviceId, protocolVersion: plugin.protocolVersion },
        });
        // Sealed as it was: it opens with the same KRAFTVERK_SECRET_KEY.
        const secret = handle
          .query<{ value: string; encrypted: number }, [string]>("SELECT value, encrypted FROM plugin_secret WHERE plugin_id = ? AND field = 'localKey'")
          .get(TUYA_PLUGIN);
        if (secret) {
          handle
            .query("INSERT INTO connection_secret (connection_id, field, value, encrypted) VALUES (?, 'localKey', ?, ?)")
            .run(connectionId, secret.value, secret.encrypted);
        }
        for (const entry of handle.query<{ key: string; value: string }, [string]>('SELECT key, value FROM plugin_kv WHERE plugin_id = ?').all(TUYA_PLUGIN)) {
          handle.query('INSERT OR IGNORE INTO device_kv (device_id, key, value) VALUES (?, ?, ?)').run(device.id, entry.key, entry.value);
        }
      } else if (first) {
        notes.push(`"${device.name}" was never given an address and device id, so it has no way to reach it yet`);
      }
      if (first) fromPlugin.set(TUYA_PLUGIN, device.id);
      audit('migration.plug', device.id, `"${device.name}" is now a ${generic ? 'Tuya smart plug' : 'ATORCH S1W'}, set up from the old plugin's settings`);
      continue;
    }

    if (device.driver === FAKE_PLUGIN) {
      handle.query('DELETE FROM sample WHERE device_id = ?').run(device.id);
      handle.query('DELETE FROM device WHERE id = ?').run(device.id);
      audit('device.removed', device.id, `Removed "${device.name}", a simulated plug: simulators are no longer devices you add`, { driver: device.driver });
      continue;
    }

    // A type this server may no longer have installed: kept, and shown as such.
    setDevice(device.id, device.driver, null, device.config);
  }

  // --- the relay's station, as a link -------------------------------------------
  const station = handle.query<{ value: string }, [string]>('SELECT value FROM app_state WHERE key = ?').get(RELAY_STATION_KEY)?.value;
  const active = handle.query<{ plugin_id: string }, []>("SELECT plugin_id FROM active_provider WHERE resource = 'gridRelay'").get()?.plugin_id;
  const plug = fromPlugin.get(active ?? TUYA_PLUGIN);
  const stationExists = station && handle.query('SELECT 1 FROM device WHERE id = ?').get(station);
  if (plug && station && stationExists && plug !== station) {
    handle.query("INSERT INTO device_link (id, kind, source_id, target_id, created_at) VALUES (?, 'feeds', ?, ?, ?)").run(id('l'), plug, station, now);
    audit('link.added', plug, 'The grid relay pairing became a link: this plug feeds the station', { target: station });
  }
  handle.query('DELETE FROM app_state WHERE key = ?').run(RELAY_STATION_KEY);

  // --- the gateway's memory of each plug, by device --------------------------------
  for (const [plugin, deviceId] of fromPlugin) {
    for (const memory of ['gateway.lastSwitchAt', 'gateway.everSwitched']) {
      handle.query('UPDATE app_state SET key = ? WHERE key = ?').run(`${memory}.${deviceId}`, `${memory}.${plugin}`);
    }
  }

  // --- the old shape goes ------------------------------------------------------------
  handle.exec(`
    DROP TABLE plugin_config;
    DROP TABLE plugin_secret;
    DROP TABLE plugin_kv;
    DROP TABLE capability_grant;
    DROP TABLE active_provider;
    ALTER TABLE device DROP COLUMN type;
    ALTER TABLE device DROP COLUMN model;
    ALTER TABLE device DROP COLUMN driver;
    CREATE UNIQUE INDEX device_identity ON device (identity) WHERE identity IS NOT NULL AND removed_at IS NULL;
  `);

  audit('migration.7', null, `Devices are now reached through connections${notes.length ? `. ${notes.join('. ')}` : ''}`, { devices: devices.length });
}
