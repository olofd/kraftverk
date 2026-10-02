import { AutomationEngine, AutomationLibrary } from '@kraftverk/automation-engine';
import type { AuditRecord, PolicyValueName, PolicyValues, ScopedHttp } from '@kraftverk/device-sdk';
import type { Caller, KraftverkApi } from '@kraftverk/api-contract';
import { ActionGateway, Confirmations, type GatewayPolicy } from '@kraftverk/gateway';
import { LiveBus, SessionManager } from '@kraftverk/holder';
import {
  AppState,
  AuditLog,
  AutomationStore,
  HomeStore,
  PlaceStore,
  NodeStore,
  ConnectionStore,
  databaseLedger,
  resetDatabase,
  DeviceCatalog,
  deviceStore,
  EventStore,
  holding,
  LinkStore,
  policyValues,
  setPolicyValue,
  type NodeDeclaration,
  type NodeRecord,
  type SecretsAtRest,
  type SqlDatabase,
} from '@kraftverk/store';

import { homeApi } from './api/index.ts';
import { Attention } from './attention/attention.ts';
import { keepWatchedFresh } from './attention/freshness.ts';
import { homeDevices } from './automations/devices.ts';
import { plans } from './automations/plans.ts';
import { Configuration } from './configuration/configuration.ts';
import type { PassphraseSealing } from './configuration/seal.ts';
import { Nearby } from './devices/nearby.ts';
import { DeviceRegistry } from './devices/registry.ts';
import { RemoteReadings } from './devices/remote.ts';
import { ChangeLog } from './history/changes.ts';
import { Sampler } from './history/sampler.ts';
import { unfitFor } from './installed/needs.ts';
import type { ProtocolRegistry } from './installed/protocols.ts';
import type { TransportHost } from './installed/transports.ts';
import type { DeviceTypeRegistry } from './installed/types.ts';
import { KeepingCopy } from './handover/keep.ts';
import { SetupService } from './setup/index.ts';

/**
 * What is installed where a home runs: its device types (and what their
 * packages bring to automations), protocols and transports. The place fills
 * them — the server from its disk, the app from its generated registry, a
 * test with what it brings — and the hub runs what is in them.
 */
export type Installed = {
  types: DeviceTypeRegistry;
  protocols: ProtocolRegistry;
  transports: TransportHost;
};

/** What a home is made from: everything only the place it runs can give it (docs/PLAN-SHARED-CORE.md, phase 5). */
export type HubOptions = {
  /** Where the home is kept, its schema current: the place opens it, and sets an older one aside. */
  database: SqlDatabase;
  /** How a connection's secrets are sealed at rest: the server's key, a phone's secure storage. */
  secrets: SecretsAtRest;
  /** How a passphrase seals a secret for an export, and opens one: the place's cipher. */
  sealing: PassphraseSealing;
  installed: Installed;
  /** Every write to hardware refused: the server's launch, an app's switch. A simulated device reaches no hardware. */
  readOnly: () => boolean;
  /** Frames nobody has described may be sent, by a type's raw-frame tool. Never in an app. */
  allowRawFrames?: boolean;
  /** For a setup helper that calls a vendor's API once — fetching a key. */
  http: ScopedHttp;
  /**
   * The timeline, when the place keeps its own over the same database — the
   * server's, which accounts and sign-in write to as well. Made here when
   * not given.
   */
  audit?: AuditLog;
  /**
   * The node this hub is: its id — the place's to keep, the same in every
   * home it is part of — its name, and what it declares it is. Its database
   * is this node's; the home, made the first time, has it as its master.
   */
  node: Omit<NodeDeclaration, 'platform' | 'transports'>;
  /**
   * The copy an app kept of the server it used last, if this is that app's
   * own home: offered to keep (`configuration.plan({ from: 'copy' })`).
   */
  copy?: SqlDatabase;
  /** The gateway's own limits, where they differ from its defaults: a test's shorter wait to verify. */
  gateway?: Partial<GatewayPolicy>;
  /** Where it says what happened: a line for a person reading a log. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
};

/**
 * A kraftverk home, running (README.md): its stores over the database it is
 * given, one session for every device it holds, the gateway every action
 * goes through, the engine, history, setup, what is near, attention and its
 * configuration — each made here, from what the place gave, and nothing at
 * module level, so two homes run side by side in one process.
 *
 * `start()` starts what runs on its own — the transports its devices need,
 * their sessions, sampling, the engine, keeping watched devices fresh — and
 * `stop()` stops all of it. Restoring a configuration after a reset is the
 * place's to ask for (`configuration.restore`), as only it knows its
 * database was just made.
 */
export class Hub {
  readonly db: SqlDatabase;
  readonly installed: Installed;
  readonly readOnly: () => boolean;

  // What it keeps.
  readonly audit: AuditLog;
  readonly state: AppState;
  /** The home this database keeps, and its master. */
  readonly home: HomeStore;
  /** Where the home's nodes and devices stand. */
  readonly places: PlaceStore;
  /** This node: what its database is, and what holds the ways it holds. */
  get self(): NodeRecord {
    return this.nodes.self()!;
  }
  readonly catalog: DeviceCatalog;
  readonly connections: ConnectionStore;
  readonly links: LinkStore;
  readonly nodes: NodeStore;
  readonly events: EventStore;
  readonly automations: AutomationStore;
  readonly policy: { values(): PolicyValues; set(name: PolicyValueName, value: number | null): PolicyValues };

  // What runs.
  /** What devices say as they say it, and what changed: what a live stream, the engine and the change log hear. */
  readonly bus = new LiveBus();
  readonly sessions: SessionManager;
  readonly gateway: ActionGateway;
  readonly library: AutomationLibrary;
  readonly engine: AutomationEngine;
  readonly plans: ReturnType<typeof plans>;

  // What it does for whoever uses it.
  /** Readings an app sends for a connection it holds for this home. */
  readonly remote: RemoteReadings;
  readonly registry: DeviceRegistry;
  readonly setup: SetupService;
  readonly nearby: Nearby;
  readonly sampler: Sampler;
  readonly changeLog: ChangeLog;
  /** What the people using it are looking at, said by their apps. */
  readonly attention = new Attention();
  readonly configuration: Configuration;
  /**
   * The tokens a person's yes is sent back with, for what the gateway does
   * not ask itself: a tool that cannot be undone, an automation let act.
   * Each good once, for a minute, bound to what was asked and who.
   */
  readonly yes = { tools: new Confirmations(), arming: new Confirmations() };
  /** A server's home this app kept a copy of, to keep as its own: none on a server, or when there is none. */
  readonly keeping: KeepingCopy | null;

  #log: NonNullable<HubOptions['log']>;
  #stopFreshness: (() => void) | null = null;
  #started = false;

  constructor(options: HubOptions) {
    const db = options.database;
    this.db = db;
    this.installed = options.installed;
    this.readOnly = options.readOnly;
    this.#log = options.log ?? ((level, message) => console[level === 'info' ? 'log' : level](message));
    const { types, protocols, transports } = options.installed;

    this.audit = options.audit ?? new AuditLog(db);
    const record = (entry: AuditRecord) => this.audit.record(entry);
    this.state = new AppState(db);
    this.catalog = new DeviceCatalog(db);
    this.connections = new ConnectionStore(db, options.secrets);
    this.links = new LinkStore(db);
    this.nodes = new NodeStore(db);
    this.home = new HomeStore(db);
    this.places = new PlaceStore(db);
    // This node, as it declares itself at every start; the home, made the first time, its master.
    const here = transports.definitions().filter((definition) => definition.platforms.includes(transports.platform)).map((definition) => definition.id);
    const self = this.nodes.declareSelf({ ...options.node, platform: transports.platform, transports: here });
    // A hub is the master of what its database keeps: never a copy another node is the master of.
    const home = this.home.ensure({ name: 'Home', masterId: self.id });
    if (home.masterId !== self.id) throw new Error(`This database is kept for another master (${home.masterId}): it is not opened as a home of its own`);
    this.events = new EventStore(db);
    this.automations = new AutomationStore(db);
    this.policy = { values: () => policyValues(this.state), set: (name, value) => setPolicyValue(this.state, name, value) };

    const { catalog, connections, links, nodes, events, automations } = this;
    this.sessions = new SessionManager({
      platform: transports.platform,
      node: { id: self.id, name: self.name },
      types,
      protocols,
      transports,
      // What this node holds of the home: the ways held by its id.
      ...holding(connections, self.id),
      store: (deviceId) => deviceStore(db, deviceId),
      readOnly: options.readOnly,
      allowRawFrames: options.allowRawFrames ?? false,
      nodeName: (id) => nodes.get(id)?.name ?? null,
      // A way this node is not what it needs of — brought in by a file, or a home handed over — waits for one that is.
      unfit: (method) => unfitFor(method, self),
      record,
      // A device saved before it ever answered learns who it is the first time it does.
      onIdentified: (deviceId, identity) => {
        if (catalog.byIdentity(identity).active) return;
        catalog.update(deviceId, { identity });
      },
      onDescribed: (deviceId, description, info, source) => catalog.describe(deviceId, description, info, source),
      onEvent: (deviceId, event) => events.record(deviceId, event),
      bus: this.bus,
      log: (message) => this.#log('info', `[devices] ${message}`),
    });
    const { sessions } = this;

    /**
     * The only path a command to hardware takes. What a part is linked to
     * comes from the links, so a command on it is verified against what it
     * reaches.
     */
    this.gateway = new ActionGateway({
      device: (id) => {
        const device = catalog.active(id);
        return device ? { name: device.name, session: sessions.get(id), description: sessions.description(device), offline: sessions.health(device).detail } : null;
      },
      linksFrom: (id, part) => links.from(id, part).map((link) => ({ kind: link.kind, target: link.target })),
      isReadOnly: (id) => options.readOnly() && !sessions.simulated(id),
      record,
      policy: options.gateway,
      ledger: databaseLedger(db),
      policyValues: () => this.policy.values(),
    });

    /** What the installed packages bring to automations: their recipes and functions. None of the core's own. */
    this.library = new AutomationLibrary(types.contributions(), (message) => this.#log('warn', message));
    this.engine = new AutomationEngine({ store: automations, library: this.library, device: homeDevices(catalog, sessions), gateway: this.gateway, record, bus: this.bus });
    this.plans = plans({ db, catalog, sessions, library: this.library, engine: this.engine, automations });

    this.remote = new RemoteReadings(db);
    this.registry = new DeviceRegistry({ catalog, types, sessions, connections, links, nodes, transports, remote: this.remote, self: self.id, master: () => this.home.get()!.masterId, readOnly: options.readOnly });
    this.setup = new SetupService({ db, record, types, protocols, transports, catalog, connections, links, sessions, http: options.http, self: self.id, traits: (id) => nodes.get(id) });
    this.nearby = new Nearby({ types, protocols, transports, connections });
    this.sampler = new Sampler(db, this.registry);
    this.changeLog = new ChangeLog(db, this.bus, (id) => {
      const device = catalog.active(id);
      return device ? sessions.description(device) : null;
    });
    this.configuration = new Configuration({
      db,
      catalog,
      connections,
      links,
      automations,
      types,
      protocols,
      transports,
      sessions,
      library: this.library,
      engine: this.engine,
      checked: this.plans.checked,
      policy: this.policy,
      sealing: options.sealing,
      kept: options.secrets,
      self: self.id,
      record,
      bus: this.bus,
    });
    this.keeping = options.copy ? new KeepingCopy(this, options.copy, options.secrets) : null;
  }

  /**
   * Starts what runs on its own. Every transport an installed type uses
   * starts first — finding a device has to work before there is one to open
   * — then a session for every device it has, sampling and the change log,
   * the engine (which ends as interrupted a run it finds cut short), and
   * keeping what someone looks at fresh. A transport that cannot run here
   * is said, and the others carry on.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const { types, transports } = this.installed;
    const needed = new Set(types.all().flatMap((type) => type.connections.map((method) => method.transport)));
    const starting = transports.definitions().map((definition) => definition.id).filter((id) => needed.has(id));
    await transports.startAll(starting);
    for (const id of starting) {
      const available = transports.available(id);
      if (!available.ok) this.#log('warn', `[transports] ${id} is unavailable here: ${available.reason}`);
    }
    await this.sessions.sync(this.catalog.list());
    this.sampler.start();
    this.changeLog.start();
    this.engine.start();
    this.#stopFreshness = keepWatchedFresh(this.attention, (device, until) => this.sessions.get(device)?.wantFresh?.(until));
  }

  /**
   * Empties the home: every table but accounts, apps and what the database
   * is. Who may is the place's to decide — on a server, an account with the
   * reset passphrase. Order matters: sessions close first, so nothing is
   * mid-poll against a device about to stop existing, and sampling stops, so
   * nothing writes into a table being emptied. The first entry of the new
   * timeline says so; every open screen reads its list again.
   */
  async reset(by: string): Promise<{ tables: string[]; rows: number }> {
    this.sampler.stop();
    await this.sessions.closeAll();
    const { tables, rows } = resetDatabase(this.db);
    this.audit.record({ at: new Date().toISOString(), kind: 'database.reset', actor: by, summary: `The database was reset: ${rows} rows across ${tables.length} tables`, detail: { tables } });
    // Back to the state a fresh home starts in: no devices, so no sessions.
    await this.sessions.sync(this.catalog.list());
    if (this.#started) this.sampler.start();
    this.bus.publish({ kind: 'changed', deviceId: null });
    return { tables, rows };
  }

  /** Everything this home answers (`KraftverkApi`), for one caller: a person, or an assistant acting for one. */
  as(caller: Caller): KraftverkApi {
    return homeApi(this, caller);
  }

  /** Stops everything it started, together, and lets go of what it opened. The database is the place's to close. */
  async stop(): Promise<void> {
    this.#stopFreshness?.();
    this.#stopFreshness = null;
    this.configuration.stop();
    this.engine.stop();
    this.sampler.stop();
    this.changeLog.stop();
    this.setup.stop();
    this.nearby.stop();
    await Promise.allSettled([this.sessions.closeAll(), this.installed.transports.stopAll()]);
    this.#started = false;
  }
}

/** A home, made from what the place gives it: `start()` it, ask it, `stop()` it. */
export const createHub = (options: HubOptions): Hub => new Hub(options);
