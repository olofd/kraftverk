import type { ConnectionView, DeviceView, LinkView } from '@kraftverk/api-contract';
import type { ConfigValues, SavedDeviceId } from '@kraftverk/device-sdk';
import { activeConnection } from '@kraftverk/holder';

import type { TransportHost } from '../runtime/transports.ts';
import type { DeviceCatalog, DeviceRecord } from './catalog.ts';
import type { ClientStore } from './clients.ts';
import type { ConnectionRecord, ConnectionStore } from './connections.ts';
import type { LinkStore } from './links.ts';
import type { RemoteReadings } from './remote.ts';
import type { DeviceSessionManager } from './sessions.ts';
import type { DeviceTypeRegistry } from './types.ts';

/**
 * Joins the devices you added to what they are, how they are reached, and
 * what they are doing.
 *
 * The catalog says what exists; the device type says what it is; its
 * connections say how it is reached and its links how it fits the house; its
 * session says what it is doing. Every device is described the same way, so
 * the app has one card, one detail screen and one chart for everything it will
 * ever show — and this file names no product. The shapes it builds are the
 * API contract's (`@kraftverk/api-contract`), shared with the app.
 */

export class DeviceRegistry {
  constructor(
    private deps: {
      catalog: DeviceCatalog;
      types: DeviceTypeRegistry;
      sessions: DeviceSessionManager;
      connections: ConnectionStore;
      links: LinkStore;
      clients: ClientStore;
      transports: TransportHost;
      /** Readings from connections an app holds. */
      remote: RemoteReadings;
    }
  ) {}

  /** Every device you have, joined to what it is doing. */
  all(): DeviceView[] {
    const records = this.deps.catalog.list();
    const names = new Map(records.map((record) => [record.id, record.name]));
    return records.map((record) => this.#view(record, names));
  }

  /** Removed devices, kept with their history, to bring back or delete. */
  removed(): DeviceView[] {
    const names = new Map(this.deps.catalog.list().map((record) => [record.id, record.name]));
    return this.deps.catalog.removed().map((record) => this.#view(record, names));
  }

  find(id: SavedDeviceId): DeviceView | null {
    const record = this.deps.catalog.get(id);
    if (!record) return null;
    return this.#view(record, new Map(this.deps.catalog.list().map((candidate) => [candidate.id, candidate.name])));
  }

  #view(record: DeviceRecord, names: Map<SavedDeviceId, string>): DeviceView {
    const type = this.deps.sessions.typeOf(record);
    const session = record.removedAt ? null : this.deps.sessions.get(record.id);
    const opened = record.removedAt ? null : this.deps.sessions.inUse(record.id);
    const latest = record.removedAt ? null : this.deps.remote.latest(record.id);

    /*
      The active-connection rule (docs/DATA-MODEL.md §4, decision 12): of the
      connections that reach the device now — the server's open one, or an
      app's that is sending fresh readings — the one highest in the list is in
      use, and its readings are the device's. With none reachable, the one the
      server is trying.
    */
    const reachable = (connection: ConnectionRecord): boolean | null => {
      if (connection.heldBy) return latest?.connectionId === connection.id ? true : null;
      return opened?.id === connection.id ? this.deps.sessions.reachable(record.id) : null;
    };
    const ordered = [...this.deps.connections.forDevice(record.id)].sort((a, b) => a.priority - b.priority);
    const activeId = activeConnection(
      ordered.map((connection) => ({ id: connection.id, priority: connection.priority, reachable: reachable(connection) })),
      opened?.id ?? null
    );
    const active = ordered.find((connection) => connection.id === activeId) ?? null;
    // An app's readings count only while its connection is the one in use; a simulator is always its session's.
    const remote = latest && active?.id === latest.connectionId && (opened !== null || !session) ? latest : null;

    const connections = ordered.map((connection): ConnectionView => {
      const method = type?.connections.find((candidate) => candidate.id === connection.method);
      const client = connection.heldBy ? this.deps.clients.get(connection.heldBy) : null;
      return {
        id: connection.id,
        method: connection.method,
        methodLabel: method?.label ?? connection.method,
        transport: connection.transport,
        heldBy: connection.heldBy ? { kind: 'client', id: connection.heldBy, name: client?.name ?? 'Another app' } : { kind: 'server' },
        address: connection.address,
        priority: connection.priority,
        reachable: reachable(connection),
        inUse: active?.id === connection.id,
        lastConnectedAt: connection.lastConnectedAt,
        secrets: this.deps.connections.secretFields(connection.id),
        config: connection.config,
      };
    });

    const links = this.deps.links.forDevice(record.id).map((link): LinkView => {
      const role = link.sourceId === record.id ? 'source' : 'target';
      const otherId = role === 'source' ? link.targetId : link.sourceId;
      return { id: link.id, kind: link.kind, role, other: { id: otherId, name: names.get(otherId) ?? 'A removed device' } };
    });

    return {
      id: record.id,
      typeId: record.typeId,
      installed: type !== null,
      name: record.name,
      identity: record.identity,
      addedAt: record.addedAt,
      removedAt: record.removedAt,
      kind: type?.kind ?? 'hardware',
      meta: type
        ? { name: type.meta.name, brand: type.meta.brand, icon: type.meta.icon, support: type.meta.support, category: type.meta.category }
        : { name: record.typeId, icon: 'help-circle', support: 'experimental', category: 'unknown' },
      capabilities: type?.capabilities ?? [],
      measurements: type?.telemetry ?? [],
      controls: type?.controls ?? [],
      settings: type?.settings ?? null,
      config: record.config,
      connections,
      links,
      advanced: remote ? [] : Object.entries(session?.advanced ?? {}).map(([name, action]) => ({ name, writes: action.writes })),
      readings: remote?.readings ?? session?.readings() ?? [],
      health: record.removedAt
        ? { status: 'offline', detail: `Removed ${new Date(record.removedAt).toLocaleDateString()}; its history is kept`, owner: null, transport: null, lastReadingAt: null }
        : remote
          ? {
              status: 'connected',
              detail: `Connected through ${this.deps.clients.get(remote.clientId)?.name ?? 'another app'}`,
              owner: 'client',
              transport: connections.find((connection) => connection.id === remote.connectionId)?.transport ?? null,
              lastReadingAt: remote.at,
            }
          : this.deps.sessions.health(record),
    };
  }

  /** A device's own settings, as last read from it. Empty until they have been. */
  readSettings(record: DeviceRecord): ConfigValues {
    return this.deps.sessions.get(record.id)?.readSettings?.() ?? {};
  }
  // Writing them is the gateway's (ActionGateway.writeSettings): the same checks as a command.
}
