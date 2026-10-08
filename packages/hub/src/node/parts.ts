import { LINK_KINDS, type AuditRecord, type Clock, type ScopedHttp } from '@kraftverk/device-sdk';
import { ActionGateway, type GatewayDeps } from '@kraftverk/gateway';
import { LiveBus, SessionManager, type SessionManagerDeps } from '@kraftverk/holder';
import { AutomationStore, ConnectionStore, databaseLedger, DeviceCatalog, HistoryStore, integrationKept, LastReadings, LinkStore, NodeSettings, NodeStore, type NodeDeclaration, type NodeRecord, type SecretsAtRest, type SqlDatabase } from '@kraftverk/store';

import type { Installed } from '../installed/from.ts';
import { unfitFor } from '../installed/needs.ts';
import { SetupService } from '../setup/service.ts';

/*
  What every kraftverk node is made of, whatever its role (docs/ARCHITECTURE.md,
  decision 24): its own database's stores, the node it declares itself to be,
  one session manager for the ways it holds, the gateway every action goes
  through, and setup for a way it adds. The master (\`createHub\`) and a node
  that follows it (\`createFollower\`) are each these parts, with the few
  things their role decides handed in (\`NodeRole\`) — not two builds of the
  same thing.
*/

/** What only the place a node runs can give it. */
export type NodeOptions = {
  /** Where this node keeps what it keeps, its schema current. */
  database: SqlDatabase;
  /** How the secrets of the ways it holds are sealed at rest. */
  secrets: SecretsAtRest;
  installed: Installed;
  /** The node this is: its own id, its name, and what it declares it is. */
  node: Omit<NodeDeclaration, 'platform' | 'transports'>;
  /** Every write to hardware refused: the server's launch, an app's switch. */
  readOnly: () => boolean;
  /** What that is called here, in a refusal: "The server is in read-only mode", "Writes from this app are off". */
  readOnlyReason?: string;
  /** For a setup helper that calls a vendor's API once — fetching a key. */
  http: ScopedHttp;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** The home's time: what its devices, the gateway and the automations keep. Real time when not given. */
  clock?: Clock;
};

/** What a node's role decides of its parts: the master's, and a follower's, differ only in these. */
export type NodeRole = {
  /** How its lines are tagged in the log: \`devices\`, \`follower\`. */
  tag: string;
  /** Where its timeline goes: the home's own, or owed to the master. */
  record(entry: AuditRecord): void;
  /** Which of the home's ways its sessions hold, and their secrets. */
  ways(stores: { connections: ConnectionStore; self: NodeRecord }): Pick<SessionManagerDeps, 'connections' | 'holds' | 'secret' | 'secretFields' | 'keepSecret' | 'onConnected'>;
  /** What else its sessions are handed: where a device's store is, what is done with what a device says. */
  sessions: Pick<SessionManagerDeps, 'store' | 'onEvent'> & Partial<Pick<SessionManagerDeps, 'allowRawFrames' | 'nodeName' | 'onIdentified' | 'onDescribed'>>;
  /** How its gateway finds a device and what it is linked to; what read-only is called here. */
  gateway(parts: { catalog: DeviceCatalog; sessions: SessionManager }): Pick<GatewayDeps, 'device' | 'linksFrom' | 'policy' | 'policyValues'>;
};

export type NodeParts = {
  db: SqlDatabase;
  /** This node, as it declared itself to its own database just now. */
  self: NodeRecord;
  /** What this node has settled for the home it keeps, by name. */
  settings: NodeSettings;
  catalog: DeviceCatalog;
  connections: ConnectionStore;
  links: LinkStore;
  nodes: NodeStore;
  /** What its sessions say, as they say it: readings, health, events. */
  bus: LiveBus;
  sessions: SessionManager;
  gateway: ActionGateway;
  setup: SetupService;
};

/** A node's parts, made for its role. */
export function nodeParts(options: NodeOptions, role: NodeRole): NodeParts {
  const db = options.database;
  const { types, protocols, transports } = options.installed;
  const settings = new NodeSettings(db);
  const catalog = new DeviceCatalog(db);
  const connections = new ConnectionStore(db, options.secrets);
  const links = new LinkStore(db);
  const nodes = new NodeStore(db);
  // This node, as it declares itself at every start: what it is, and what it reaches devices over here.
  const self = nodes.declareSelf({ ...options.node, platform: transports.platform, transports: transports.here() });
  const bus = new LiveBus();

  const sessions: SessionManager = new SessionManager({
    platform: transports.platform,
    node: { id: self.id, name: self.name },
    types,
    // A device opens after its integration has loaded: its protocols' code is there by then.
    protocols: { get: (id) => protocols.loaded(id) },
    transports,
    ...role.ways({ connections, self }),
    // A way this node is not what it needs of — brought in by a file, or a home handed over — waits for one that is.
    unfit: (method) => unfitFor(method, self),
    readOnly: options.readOnly,
    allowRawFrames: false,
    clock: options.clock,
    // A simulated switch that feeds a part of a simulated device is its mains, as the link says: on, power; off, none.
    fed: (deviceId, part): boolean | null => {
      const { evidence } = LINK_KINDS.feeds;
      const feeding = links.forDevice(deviceId).filter((link) => link.kind === 'feeds' && link.target.device === deviceId && link.target.part === part && sessions.simulated(link.source.device));
      if (!feeding.length) return null;
      return feeding.some((link) => sessions.reads(link.source.device, link.source.part, evidence.follows) === true);
    },
    ...role.sessions,
    record: (entry) => role.record(entry),
    bus,
    // What each device last said: what it shows, as it was, until it says again after a restart.
    lastReadings: new LastReadings(db),
    log: (message) => options.log('info', `[${role.tag}] ${message}`),
  });

  /** The only path a command to hardware takes, over what this node holds. */
  const gateway = new ActionGateway({
    ...role.gateway({ catalog, sessions }),
    ...(options.readOnlyReason ? { readOnlyReason: options.readOnlyReason } : {}),
    isReadOnly: (id) => options.readOnly() && !sessions.simulated(id),
    clock: options.clock,
    record: (entry) => role.record(entry),
    ledger: databaseLedger(db),
  });

  const setup = new SetupService({
    db,
    record: (entry) => role.record(entry),
    types,
    protocols,
    transports,
    catalog,
    connections,
    links,
    // A device moving to another type takes its history and the automations that use it along (§2.1 of docs/PLAN-ZIGBEE.md).
    history: new HistoryStore(db),
    automations: new AutomationStore(db),
    sessions,
    http: options.http,
    kept: (integration) => integrationKept(db, options.secrets, integration),
    self: self.id,
    traits: (id) => nodes.get(id),
  });

  return { db, self, settings, catalog, connections, links, nodes, bus, sessions, gateway, setup };
}
