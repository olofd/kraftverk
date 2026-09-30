import type { ConnectionView, DeviceView, LinkView, PictureRef } from '@kraftverk/api-contract';
import { deviceCapabilities, MAIN_PART, methodOf, partsOf, type DeviceDescription, type SavedDeviceId } from '@kraftverk/device-sdk';
import { activeConnection, toolsOf } from '@kraftverk/holder';

import type { TransportHost } from '../runtime/transports.ts';
import type { DeviceCatalog, DeviceRecord } from './catalog.ts';
import type { ClientRecord, ClientStore } from './clients.ts';
import type { ConnectionRecord, ConnectionStore } from './connections.ts';
import type { LinkRecord, LinkStore } from './links.ts';
import type { RemoteReadings } from './remote.ts';
import type { DeviceSessionManager } from './sessions.ts';
import type { DeviceTypeRegistry } from './types.ts';

/**
 * Joins the devices you added to what they are, how they are reached, and
 * what they are doing.
 *
 * The catalog says what exists and what each device was last described as;
 * its open session says what it is now and what it is doing; its connections
 * say how it is reached and its links how it fits the house. Every device is described the same way, so
 * the app has one card, one detail screen and one chart for everything it will
 * ever show — and this file names no product. The shapes it builds are the
 * API contract's (`@kraftverk/api-contract`), shared with the app.
 *
 * A list is built from one read of each table — connections, their secrets'
 * names, links, clients — whatever the number of devices, since the app asks
 * for it every few seconds.
 */

/** What every view in one answer is joined from, read once. */
type Joined = {
  names: Map<SavedDeviceId, string>;
  /** What each device is now, for naming the part a link reaches. */
  descriptions: Map<SavedDeviceId, DeviceDescription>;
  connections: Map<SavedDeviceId, ConnectionRecord[]>;
  secrets: Map<string, string[]>;
  links: Map<SavedDeviceId, LinkRecord[]>;
  clients: Map<string, ClientRecord>;
};

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
    const joined = this.#join(records);
    return records.map((record) => this.#view(record, joined));
  }

  /** Removed devices, kept with their history, to bring back or delete. */
  removed(): DeviceView[] {
    const joined = this.#join(this.deps.catalog.list());
    return this.deps.catalog.removed().map((record) => this.#view(record, joined));
  }

  find(id: SavedDeviceId): DeviceView | null {
    const record = this.deps.catalog.get(id);
    if (!record) return null;
    return this.#view(record, this.#join(this.deps.catalog.list()));
  }

  #join(active: DeviceRecord[]): Joined {
    const links = new Map<SavedDeviceId, LinkRecord[]>();
    for (const link of this.deps.links.all()) {
      for (const end of new Set([link.source.device, link.target.device])) links.set(end, [...(links.get(end) ?? []), link]);
    }
    return {
      names: new Map(active.map((record) => [record.id, record.name])),
      descriptions: new Map(active.map((record) => [record.id, this.deps.sessions.description(record)])),
      connections: this.deps.connections.byDevice(),
      secrets: this.deps.connections.secretFieldsByConnection(),
      links,
      clients: new Map(this.deps.clients.all().map((client) => [client.id, client])),
    };
  }

  #view(record: DeviceRecord, joined: Joined): DeviceView {
    const { names } = joined;
    const type = this.deps.sessions.typeOf(record);
    const session = record.removedAt ? null : this.deps.sessions.get(record.id);
    const description = record.removedAt ? record.description : this.deps.sessions.description(record);
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
    const ordered = joined.connections.get(record.id) ?? [];
    const activeId = activeConnection(
      ordered.map((connection) => ({ id: connection.id, priority: connection.priority, reachable: reachable(connection) })),
      opened?.id ?? null
    );
    const active = ordered.find((connection) => connection.id === activeId) ?? null;
    // An app's readings count only while its connection is the one in use; a simulator is always its session's.
    const remote = latest && active?.id === latest.connectionId && (opened !== null || !session) ? latest : null;

    const connections = ordered.map((connection): ConnectionView => {
      const method = type ? methodOf(type, connection.method) : null;
      const client = connection.heldBy ? joined.clients.get(connection.heldBy) : null;
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
        secrets: joined.secrets.get(connection.id) ?? [],
        config: connection.config,
      };
    });

    const links = (joined.links.get(record.id) ?? []).map((link): LinkView => {
      const role = link.source.device === record.id ? 'source' : 'target';
      const [mine, other] = role === 'source' ? [link.source, link.target] : [link.target, link.source];
      const otherDescription = joined.descriptions.get(other.device);
      const partLabel = other.part === MAIN_PART ? '' : (otherDescription ? partsOf(otherDescription).find((part) => part.id === other.part)?.label : undefined) ?? other.part;
      return { id: link.id, kind: link.kind, role, part: mine.part, other: { id: other.device, name: names.get(other.device) ?? 'A removed device', part: other.part, partLabel } };
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
      description,
      descriptionSource: record.removedAt ? record.descriptionSource : this.deps.sessions.describedBy(record),
      capabilities: deviceCapabilities(description),
      info: record.removedAt ? record.info : this.deps.sessions.info(record),
      config: record.config,
      connections,
      links,
      // What its session can run here; an app holding it runs its own.
      tools: remote ? [] : toolsOf(type?.tools, session).map(({ name, spec }) => ({ name, ...spec })),
      readings: remote?.readings ?? session?.readings() ?? [],
      health: record.removedAt
        ? { status: 'offline', detail: `Removed ${new Date(record.removedAt).toLocaleDateString()}; its history is kept`, owner: null, transport: null, lastReadingAt: null }
        : remote
          ? {
              status: 'connected',
              detail: `Connected through ${joined.clients.get(remote.clientId)?.name ?? 'another app'}`,
              owner: 'client',
              transport: connections.find((connection) => connection.id === remote.connectionId)?.transport ?? null,
              lastReadingAt: remote.at,
            }
          : this.deps.sessions.health(record),
      picture: pictureOf(record.picture),
    };
  }
}

/** What a picture reference may be: one of its type's, or (not built yet) its owner's own. */
export const PICTURE_REF = /^(type:(0|[1-9]\d?)|own:[a-z0-9-]{1,40})$/;

const pictureOf = (kept: string | null): PictureRef => (kept && PICTURE_REF.test(kept) ? (kept as PictureRef) : 'type:0');
