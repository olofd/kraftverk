import type { ConnectionView, DeviceView, LinkView, PictureRef, PlacementView } from '@kraftverk/api-contract';
import { deviceCapabilities, MAIN_PART, methodOf, partsOf, type DeviceDescription, type DeviceSession, type NodeId, type SavedDeviceId } from '@kraftverk/device-sdk';
import { activeConnection, toolsOf } from '@kraftverk/holder';

import type { TransportHost } from '../installed/transports.ts';
import type { DeviceCatalog, DeviceRecord, NodeRecord, NodeStore, ConnectionRecord, ConnectionStore, LinkRecord, LinkStore } from '@kraftverk/store';
import type { HeldReadings } from '../nodes/held-readings.ts';
import type { SessionManager } from '@kraftverk/holder';
import type { DeviceTypeRegistry } from '../installed/types.ts';

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
 * names, links, nodes — whatever the number of devices, since the app asks
 * for it every few seconds.
 */

/** What every view in one answer is joined from, read once. */
type Joined = {
  names: Map<SavedDeviceId, string>;
  /** Each device's key: what a way through it names it by in a file. */
  keys: Map<SavedDeviceId, string>;
  /** What each device is now, for naming the part a link reaches. */
  descriptions: Map<SavedDeviceId, DeviceDescription>;
  connections: Map<SavedDeviceId, ConnectionRecord[]>;
  secrets: Map<string, string[]>;
  links: Map<SavedDeviceId, LinkRecord[]>;
  nodes: Map<string, NodeRecord>;
};

export class DeviceViews {
  constructor(
    private deps: {
      catalog: DeviceCatalog;
      types: DeviceTypeRegistry;
      sessions: SessionManager;
      connections: ConnectionStore;
      links: LinkStore;
      nodes: NodeStore;
      transports: TransportHost;
      /** Readings from connections another node holds. */
      heldReadings: HeldReadings;
      /** This node: the ways it holds are its own sessions'. */
      self: NodeId;
      /** The home's master: what a way it holds is said as. */
      master: () => NodeId;
      /** Every write to hardware refused, now. */
      readOnly: () => boolean;
      /** Where a device stands now, its main part: in which space of which home. */
      placement: (id: SavedDeviceId) => PlacementView | null;
      /** Its labels' ids. */
      labels: (id: SavedDeviceId) => string[];
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

  /** One device, joined with only what its view names: its connections and their holders, the bridges they go through, and the devices its links reach. */
  find(id: SavedDeviceId): DeviceView | null {
    const record = this.deps.catalog.get(id);
    if (!record) return null;
    const links = this.deps.links.forDevice(record.id);
    const connections = this.deps.connections.forDevice(record.id);
    const bridges = [...new Set(connections.flatMap((connection) => (connection.through ? [connection.through] : [])))].flatMap((bridge) => this.deps.catalog.active(bridge) ?? []);
    const others = [
      ...[...new Set(links.flatMap((link) => [link.source.device, link.target.device]))].filter((other) => other !== record.id).flatMap((other) => this.deps.catalog.active(other) ?? []),
      ...bridges,
    ];
    return this.#view(record, {
      names: new Map([record, ...others].map((each) => [each.id, each.name])),
      keys: new Map([record, ...others].map((each) => [each.id, each.key])),
      descriptions: new Map([record, ...others].map((each) => [each.id, this.deps.sessions.description(each)])),
      // A bridge's own ways say which node holds what goes through it.
      connections: new Map([[record.id, connections], ...bridges.map((bridge) => [bridge.id, this.deps.connections.forDevice(bridge.id)] as const)]),
      secrets: new Map(connections.map((connection) => [connection.id, this.deps.connections.secretFields(connection.id)])),
      links: new Map([[record.id, links]]),
      nodes: new Map(this.deps.nodes.all().map((node) => [node.id, node])),
    });
  }

  #join(active: DeviceRecord[]): Joined {
    const links = new Map<SavedDeviceId, LinkRecord[]>();
    for (const link of this.deps.links.all()) {
      for (const end of new Set([link.source.device, link.target.device])) links.set(end, [...(links.get(end) ?? []), link]);
    }
    return {
      names: new Map(active.map((record) => [record.id, record.name])),
      keys: new Map(active.map((record) => [record.id, record.key])),
      descriptions: new Map(active.map((record) => [record.id, this.deps.sessions.description(record)])),
      connections: this.deps.connections.byDevice(),
      secrets: this.deps.connections.secretFieldsByConnection(),
      links,
      nodes: new Map(this.deps.nodes.all().map((node) => [node.id, node])),
    };
  }

  #view(record: DeviceRecord, joined: Joined): DeviceView {
    const { names } = joined;
    const type = this.deps.sessions.typeOf(record);
    const session = record.removedAt ? null : this.deps.sessions.get(record.id);
    const description = record.removedAt ? record.description : this.deps.sessions.description(record);
    const opened = record.removedAt ? null : this.deps.sessions.inUse(record.id);
    const latest = record.removedAt ? null : this.deps.heldReadings.latest(record.id);

    /*
      The active-connection rule (docs/DATA-MODEL.md §4, decision 12): of the
      connections that reach the device now — this node's open one, or
      another node's that is sending fresh readings — the one highest in the list is in
      use, and its readings are the device's. With none reachable, the one the
      server is trying.
    */
    const reachable = (connection: ConnectionRecord): boolean | null => {
      // This node's open one says itself; another's, by its fresh readings.
      if (opened?.id === connection.id) return this.deps.sessions.reachable(record.id);
      if (connection.heldBy === this.deps.self) return null;
      return latest?.connectionId === connection.id ? true : null;
    };
    /*
      Which node has a way in hand: its own for one it holds; for one through a
      bridge, whichever holds the bridge — this one when the bridge is open
      here, else the node its preferred way is held by.
    */
    const holderOf = (connection: ConnectionRecord, depth = 0): NodeId => {
      if (connection.heldBy !== null) return connection.heldBy;
      if (this.deps.sessions.inUse(connection.through) || depth >= 4) return this.deps.self;
      const preferred = (joined.connections.get(connection.through) ?? [])[0];
      return preferred ? holderOf(preferred, depth + 1) : this.deps.self;
    };
    const ordered = joined.connections.get(record.id) ?? [];
    const activeId = activeConnection(
      ordered.map((connection) => ({ id: connection.id, priority: connection.priority, reachable: reachable(connection) })),
      opened?.id ?? null
    );
    const active = ordered.find((connection) => connection.id === activeId) ?? null;
    // Another node's readings count only while its connection is the one in use; a simulator is always its session's.
    const remote = latest && active?.id === latest.connectionId && (opened !== null || !session) ? latest : null;

    const connections = ordered.map((connection): ConnectionView => {
      const method = type ? methodOf(type, connection.method) : null;
      const heldBy = holderOf(connection);
      const holder = joined.nodes.get(heldBy);
      return {
        id: connection.id,
        method: connection.method,
        methodLabel: method?.label ?? connection.method,
        transport: connection.transport,
        heldBy: { kind: heldBy === this.deps.master() ? 'master' : 'node', id: heldBy, name: holder?.name ?? 'Another node' },
        through: connection.through !== null ? { id: connection.through, key: joined.keys.get(connection.through) ?? '', name: names.get(connection.through) ?? 'A removed device' } : null,
        address: connection.address,
        priority: connection.priority,
        reachable: reachable(connection),
        inUse: active?.id === connection.id,
        lastConnectedAt: connection.lastConnectedAt,
        secrets: joined.secrets.get(connection.id) ?? [],
        secretsExportable: connection.secretsExportable,
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
      key: record.key,
      typeId: record.typeId,
      installed: type !== null,
      name: record.name,
      identity: record.identity,
      addedAt: record.addedAt,
      removedAt: record.removedAt,
      pausedAt: record.pausedAt,
      trackDays: record.trackDays,
      placement: record.removedAt ? null : this.deps.placement(record.id),
      labels: this.deps.labels(record.id),
      kind: type?.kind ?? 'hardware',
      integration: this.deps.types.sourceOf(record.typeId)?.integration ?? null,
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
      // What its session can run here; another node holding it runs its own.
      tools: remote ? [] : toolsOf(type?.tools, session).map(({ name, spec }) => ({ name, ...spec })),
      joins: remote ? null : joinsOf(session),
      // What it says now, and what it last said of the rest, as it was: its last state, drawn rather than hidden.
      readings: remote?.readings ?? (record.removedAt ? [] : this.deps.sessions.readings(record.id)),
      health: record.removedAt
        ? { status: 'offline', detail: `Removed ${new Date(record.removedAt).toLocaleDateString()}; its history is kept`, node: null, transport: null, lastReadingAt: null }
        : remote
          ? {
              status: 'connected',
              detail: `Connected through ${joined.nodes.get(remote.nodeId)?.name ?? 'another node'}`,
              node: remote.nodeId,
              transport: connections.find((connection) => connection.id === remote.connectionId)?.transport ?? null,
              lastReadingAt: remote.at,
            }
          : this.deps.sessions.health(record),
      // Said by this node only for what it holds itself; one another node holds, that node says.
      readOnly: !record.removedAt && !remote && this.deps.readOnly() && !this.deps.sessions.simulated(record.id),
      picture: pictureOf(record.picture),
    };
  }
}

/** For a bridge new devices join, open here: until when they may, and for how long at most. */
export const joinsOf = (session: DeviceSession | null | undefined): DeviceView['joins'] =>
  session?.bridge?.join ? { until: session.bridge.join.until(), maxSeconds: session.bridge.join.maxSeconds } : null;

/** What a picture reference may be: one of its type's, or (not built yet) its owner's own. */
export const PICTURE_REF = /^(type:(0|[1-9]\d?)|own:[0-9a-f]{64})$/;

/** Its type's first picture: what a device shows with no pick, kept as none. */
export const FIRST_PICTURE = 'type:0' satisfies PictureRef;

const pictureOf = (kept: string | null): PictureRef => (kept && PICTURE_REF.test(kept) ? (kept as PictureRef) : FIRST_PICTURE);
