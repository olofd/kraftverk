import { AutomationEngine, AutomationLibrary, type EngineWorld } from '@kraftverk/automation-engine';
import { isPosition, SYSTEM, type Actor, type AuditRecord, type Clock, type PolicyValueName, type PolicyValues, type ScopedHttp } from '@kraftverk/device-sdk';
import type { Caller, KraftverkApi } from '@kraftverk/api-contract';
import { ActionGateway, Confirmations, type GatewayPolicy } from '@kraftverk/gateway';
import { LiveBus, SessionManager } from '@kraftverk/holder';
import {
  AuditLog,
  AutomationStore,
  HistoryStore,
  TrackStore,
  HomeSettings,
  NodeSettings,
  PlaceStore,
  MediaStore,
  SpaceStore,
  LabelStore,
  PeopleStore,
  InvitationStore,
  ShortcutStore,
  DevicePeopleStore,
  PresenceStore,
  OccupancyStore,
  ModeStore,
  NotificationStore,
  FamilyStore,
  NodeStore,
  ConnectionStore,
  resetDatabase,
  DeviceCatalog,
  deviceStore,
  EventStore,
  holding,
  IgnoredSightings,
  LinkStore,
  policyValues,
  setPolicyValue,
  type NodeDeclaration,
  type NodeRecord,
  type SecretsAtRest,
  type SqlDatabase,
} from '@kraftverk/store';

import { familyApi } from '../api/index.ts';
import { deviceHomeOf, ensureFirstHome, locationOf, policyOf } from '../homes/homes.ts';
import { Attention } from '../attention/attention.ts';
import { keepWatchedFresh } from '../attention/freshness.ts';
import { homeDevices } from '../automations/devices.ts';
import { drafts } from '../automations/drafts.ts';
import { Configuration } from '../configuration/configuration.ts';
import type { PassphraseSealing } from '../configuration/seal.ts';
import { Nearby } from '../devices/nearby.ts';
import { DeviceViews } from '../devices/views.ts';
import { HeldReadings } from '../nodes/held-readings.ts';
import { ChangeLog } from '../history/changes.ts';
import { Sampler } from '../history/sampler.ts';
import { Presence } from '../presence/presence.ts';
import { Occupancy } from '../occupancy/occupancy.ts';
import { Modes } from '../modes/modes.ts';
import { familyWorld, type WorldDirectory } from '../automations/world.ts';
import type { PushSender } from '../notifications/notify.ts';
import { positionHidden } from '../presence/levels.ts';
import { startTransports, type Installed } from '../installed/from.ts';
import { KeepingCopy } from '../handover/keep.ts';
import { nodeParts } from './parts.ts';
import { SetupService } from '../setup/service.ts';

/** What a family's hub is made from: everything only the place it runs can give it (docs/PLAN-SHARED-CORE.md, phase 5). */
export type HubOptions = {
  /** Where the family is kept, its schema current: the place opens it, and sets an older one aside. */
  database: SqlDatabase;
  /** How a connection's secrets are sealed at rest: the server's key, a phone's secure storage. */
  secrets: SecretsAtRest;
  /** How a passphrase seals a secret for an export, and opens one: the place's cipher. */
  sealing: PassphraseSealing;
  installed: Installed;
  /** Every write to hardware refused: the server's launch, an app's switch. A simulated device reaches no hardware. */
  readOnly: () => boolean;
  /** What that is called here, in a refusal: "The server is in read-only mode", "Writes from this app are off". */
  readOnlyReason?: string;
  /**
   * The home's time: what its devices, the gateway and the automations keep.
   * Real time when not given; faster only where every write to hardware is
   * refused — every pause that protects a relay is that much shorter too.
   */
  clock?: Clock;
  /** How this place wakes an app with a notification: the server's web push. None on a phone. */
  push?: PushSender;
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
  /** The family's id, when the place chose it before the database was made: an account's own, named in its personal store and its file. */
  familyId?: string;
  /** The gateway's own limits, where they differ from its defaults: a test's shorter wait to verify. */
  gateway?: Partial<GatewayPolicy>;
  /** Where it says what happened: a line for a person reading a log. */
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
};

/**
 * A kraftverk family, running (README.md, docs/PLAN-WORLD-MODEL.md): its stores over the database it is
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
  /** What this node settled about the family it keeps: moved, kept. */
  readonly settings: NodeSettings;
  /** The family's homes and zones. */
  readonly places: PlaceStore;
  /** Pictures, by their content. */
  readonly media: MediaStore;
  /** The homes' spaces, the openings between them, and where each device stands. */
  readonly spaces: SpaceStore;
  readonly labels: LabelStore;
  readonly people: PeopleStore;
  readonly invitations: InvitationStore;
  /** Each person's own shortcuts on their home page. */
  readonly shortcuts: ShortcutStore;
  /** Who each device is with: who carries it, drives it, owns it, uses it. */
  readonly devicePeople: DevicePeopleStore;
  /** The family this database is, and its master. */
  readonly family: FamilyStore;
  /** This node: what its database is, and what holds the ways it holds. */
  get self(): NodeRecord {
    return this.nodes.self()!;
  }
  readonly catalog: DeviceCatalog;
  readonly connections: ConnectionStore;
  readonly links: LinkStore;
  readonly nodes: NodeStore;
  readonly events: EventStore;
  /** What the home recorded: samples, their roll-ups, and every change of an on/off. */
  readonly history: HistoryStore;
  /** Where devices have been, while their owners keep it. */
  readonly tracks: TrackStore;
  readonly automations: AutomationStore;
  readonly policy: { values(): PolicyValues; set(name: PolicyValueName, value: number | null): PolicyValues };

  // What runs.
  /** What devices say as they say it, and what changed: what a live stream, the engine and the change log hear. */
  readonly bus: LiveBus;
  readonly sessions: SessionManager;
  readonly gateway: ActionGateway;
  readonly library: AutomationLibrary;
  readonly engine: AutomationEngine;
  readonly drafts: ReturnType<typeof drafts>;

  // What it does for whoever uses it.
  /** Readings an app sends for a connection it holds for this home. */
  readonly heldReadings: HeldReadings;
  readonly views: DeviceViews;
  readonly setup: SetupService;
  readonly nearby: Nearby;
  /** What a person said not to offer again: found on a transport, or behind a bridge. */
  readonly ignored: IgnoredSightings;
  readonly sampler: Sampler;
  /** Where each member is: their stays at the family's homes and zones, from what they carry. */
  readonly stays: PresenceStore;
  /** What each person is told: their inbox, and where their apps are woken. */
  readonly notifications: NotificationStore;
  /** How this place wakes an app with a notification; none where nothing sends a push. */
  readonly push: PushSender | null;
  readonly presence: Presence;
  /** Whether each space has someone in it, kept: from what stands there. */
  readonly occupancies: OccupancyStore;
  readonly occupancy: Occupancy;
  /** A home's modes, and which each is in: kept, and said on the bus as they change. */
  readonly modeStore: ModeStore;
  readonly modes: Modes;
  /** The family's world as automations see it, and a draft checks what fills its roles of it against. */
  readonly world: EngineWorld & WorldDirectory;
  readonly changeLog: ChangeLog;
  /** What the people using it are looking at, said by their apps. */
  readonly attention = new Attention();
  readonly configuration: Configuration;
  /**
   * The tokens a person's yes is sent back with, for what the gateway does
   * not ask itself: a tool that cannot be undone, an automation let act.
   * Each good once, for a minute, bound to what was asked and who.
   */
  readonly yes = { tools: new Confirmations(), lettingAct: new Confirmations() };
  /** A server's home this app kept a copy of, to keep as its own: none on a server, or when there is none. */
  readonly keeping: KeepingCopy | null;

  #log: NonNullable<HubOptions['log']>;
  #stopFreshness: (() => void) | null = null;
  /** Stops the library hearing of packages as they load. */
  #stopContributions: () => void;
  #started = false;

  constructor(options: HubOptions) {
    // A fast clock shortens every pause that protects a relay: only where nothing reaches hardware.
    if ((options.clock?.rate ?? 1) > 1 && !options.readOnly()) throw new Error(`A clock ${options.clock!.rate} times real time runs only where every write to hardware is refused (read-only)`);
    const db = options.database;
    this.db = db;
    this.installed = options.installed;
    this.readOnly = options.readOnly;
    this.#log = options.log ?? ((level, message) => console[level === 'info' ? 'log' : level](message));
    const { types, protocols, transports } = options.installed;

    this.audit = options.audit ?? new AuditLog(db);
    const record = (entry: AuditRecord) => this.audit.record(entry);
    this.family = new FamilyStore(db);
    this.events = new EventStore(db);
    this.history = new HistoryStore(db);
    this.tracks = new TrackStore(db);
    this.automations = new AutomationStore(db);
    const { events, automations } = this;

    // What every node is made of, as the master: the ways held by its id, its devices' own stores, its own timeline.
    const parts = nodeParts(
      { database: db, secrets: options.secrets, installed: options.installed, node: options.node, readOnly: options.readOnly, readOnlyReason: options.readOnlyReason, http: options.http, log: this.#log, clock: options.clock },
      {
        tag: 'devices',
        record,
        home: (deviceId) => deviceHomeOf(this.places, this.spaces)(deviceId),
        // A carried device's position, kept as its last reading only at what its carrier shares.
        keeps: (deviceId, reading) => !isPosition(reading.value) || !positionHidden(this, deviceId, null),
        ways: ({ connections, self }) => holding(connections, self.id),
        sessions: {
          store: (deviceId) => deviceStore(db, deviceId),
          allowRawFrames: options.allowRawFrames ?? false,
          nodeName: (id) => this.nodes.get(id)?.name ?? null,
          // A device saved before it ever answered learns who it is the first time it does.
          onIdentified: (deviceId, identity) => {
            if (this.catalog.byIdentity(identity).active) return;
            const device = this.catalog.update(deviceId, { identity });
            // On the timeline — and so in the configuration kept beside the database, which is written again after it.
            if (device) record({ at: new Date().toISOString(), kind: 'device.identified', actor: SYSTEM, resourceKind: 'device', resource: deviceId, summary: `"${device.name}" said who it is: ${identity}`, detail: { identity } });
          },
          onDescribed: (deviceId, description, info, source) => this.catalog.describe(deviceId, description, info, source),
          onEvent: (deviceId, event) => events.record(deviceId, event),
        },
        /** What a part is linked to comes from the links, so a command on it is verified against what it reaches. */
        gateway: ({ catalog, sessions }) => ({
          device: (id) => {
            const device = catalog.active(id);
            return device ? { name: device.name, session: sessions.get(id), description: sessions.description(device), offline: sessions.health(device).detail } : null;
          },
          linksFrom: (id, part) => this.links.from(id, part).map((link) => ({ kind: link.kind, target: link.target })),
          policy: options.gateway,
          // A device's own home's values: the one it stands in, or the family's first.
          policyValues: (deviceId) => policyOf(db)(this.spaces.placement(deviceId)?.homeId ?? ensureFirstHome(this.places).id).values(),
        }),
      }
    );
    ({ settings: this.settings, catalog: this.catalog, connections: this.connections, links: this.links, nodes: this.nodes, bus: this.bus, sessions: this.sessions, gateway: this.gateway, setup: this.setup } = parts);
    const { self } = parts;
    // The family, made the first time, its master this node. A hub is the master of what its database keeps: never a copy another node is the master of.
    const family = this.family.ensure({ name: 'Family', masterId: self.id, ...(options.familyId ? { id: options.familyId } : {}) });
    if (family.masterId !== self.id) throw new Error(`This database is kept for another master (${family.masterId}): it is not opened as a family of its own`);
    // And its first home, made with it: a family has a home from the start.
    this.places = new PlaceStore(db);
    ensureFirstHome(this.places);
    this.media = new MediaStore(db);
    this.spaces = new SpaceStore(db);
    this.labels = new LabelStore(db);
    this.people = new PeopleStore(db);
    this.invitations = new InvitationStore(db);
    this.shortcuts = new ShortcutStore(db);
    this.devicePeople = new DevicePeopleStore(db);
    // The family's values, as its API sets them: its first home's. The gateway asks each device's own home (`policyValues`).
    const policyHome = new HomeSettings(db, () => ensureFirstHome(this.places).id);
    this.policy = { values: () => policyValues(policyHome), set: (name, value) => setPolicyValue(policyHome, name, value) };
    const { catalog, connections, links, nodes, sessions } = this;

    // The family's world, as its automations see it: who is where, rooms, modes; telling people.
    this.notifications = new NotificationStore(db);
    this.stays = new PresenceStore(db);
    this.push = options.push ?? null;
    this.occupancies = new OccupancyStore(db);
    this.modeStore = new ModeStore(db);
    this.modes = new Modes({ store: this.modeStore, places: this.places, bus: this.bus, clock: options.clock });
    this.world = familyWorld({ people: this.people, places: this.places, spaces: this.spaces, stays: this.stays, occupancies: this.occupancies, modes: this.modes, modeStore: this.modeStore, notifications: this.notifications, push: this.push, record });

    /** What the installed packages bring to automations: their recipes and functions. None of the core's own. */
    this.library = new AutomationLibrary(types.contributions(), (message) => this.#log('warn', message));
    // What a package brings to automations comes with its code: when its integration loads.
    this.#stopContributions = types.onContribution((contributed) => this.library.add([contributed]));
    this.engine = new AutomationEngine({ store: automations, library: this.library, device: homeDevices(catalog, sessions, (deviceId) => positionHidden(this, deviceId, null)), gateway: this.gateway, record, bus: this.bus, history: this.history, location: locationOf(this.places), world: this.world, clock: options.clock });
    this.drafts = drafts({ history: this.history, events, catalog, sessions, library: this.library, engine: this.engine, automations, world: this.world });

    this.heldReadings = new HeldReadings(this.history);
    this.views = new DeviceViews({ catalog, types, sessions, connections, links, nodes, transports, heldReadings: this.heldReadings, self: self.id, master: () => this.family.get()!.masterId, readOnly: options.readOnly, placement: (id) => this.spaces.placement(id), labels: (id) => this.labels.on({ device: id }).map((label) => label.id), people: (id) => this.devicePeople.of(id) });
    this.ignored = new IgnoredSightings(this.db);
    this.nearby = new Nearby({ types, protocols, transports, connections, catalog, sessions, ignored: this.ignored });
    this.sampler = new Sampler({ history: this.history, audit: this.audit, events, tracks: this.tracks, notifications: this.notifications }, this.views, (deviceId) => positionHidden(this, deviceId, null));
    this.presence = new Presence({ people: this.people, devicePeople: this.devicePeople, places: this.places, stays: this.stays, spaces: this.spaces, views: this.views, bus: this.bus, clock: options.clock });
    this.occupancy = new Occupancy({ places: this.places, spaces: this.spaces, store: this.occupancies, views: this.views, history: this.history, bus: this.bus, roomStays: (homeId) => this.stays.rooms(homeId), clock: options.clock });
    this.changeLog = new ChangeLog(this.history, this.bus, (id) => {
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
      checked: this.drafts.checked,
      family: this.family,
      places: this.places,
      spaces: this.spaces,
      labels: this.labels,
      people: this.people,
      shortcuts: this.shortcuts,
      devicePeople: this.devicePeople,
      modes: this.modeStore,
      media: this.media,
      policyOf: policyOf(db),
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
   * — and those that cost nothing to watch are watched for what is found;
   * then a session for every device it has, sampling and the change log,
   * the engine (which ends as interrupted a run it finds cut short), and
   * keeping what someone looks at fresh. A transport that cannot run here
   * is said, and the others carry on.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await startTransports(this.installed, this.#log);
    // What costs nothing to watch is watched from now on: a plug broadcasting is offered without anyone asking.
    this.nearby.start();
    await this.sessions.sync(this.catalog.list());
    this.sampler.start();
    this.presence.start();
    this.occupancy.start();
    this.modes.start();
    this.changeLog.start();
    this.engine.start();
    this.#stopFreshness = keepWatchedFresh(this.attention, (device, until, close) => this.sessions.get(device)?.wantFresh?.(until, close));
  }

  /**
   * Empties the home: every table but accounts, apps and what the database
   * is. Who may is the place's to decide — on a server, an account with the
   * reset passphrase. Order matters: sessions close first, so nothing is
   * mid-poll against a device about to stop existing, and sampling stops, so
   * nothing writes into a table being emptied. The first entry of the new
   * timeline says so; every open screen reads its list again.
   */
  async reset(by: Actor): Promise<{ tables: string[]; rows: number }> {
    this.sampler.stop();
    this.presence.stop();
    this.occupancy.stop();
    this.modes.stop();
    // Runs end and holds are let go before their automations' rows are: nothing steps, or fires, into an emptied home.
    this.engine.clear();
    await this.sessions.closeAll();
    const { tables, rows } = resetDatabase(this.db);
    // A family always has a home: the first made again, as when it was new.
    ensureFirstHome(this.places);
    this.modeStore.ensureBuiltIns();
    this.audit.record({ at: new Date().toISOString(), kind: 'database.reset', actor: by, summary: `The database was reset: ${rows} rows across ${tables.length} tables`, detail: { tables } });
    // Back to the state a fresh home starts in: no devices, so no sessions.
    await this.sessions.sync(this.catalog.list());
    if (this.#started) (this.sampler.start(), this.presence.start(), this.occupancy.start(), this.modes.start());
    this.bus.publish({ kind: 'changed', deviceId: null });
    return { tables, rows };
  }

  /** Everything this family answers (`KraftverkApi`), for one caller: a person, or an assistant acting for one. */
  /** The family, as one caller asks it: a person known here by their id is called what the family calls them. */
  as(caller: Caller): KraftverkApi {
    if (caller.kind !== 'person' || !caller.id) return familyApi(this, caller);
    const known = this.people.get(caller.id);
    return familyApi(this, known ? { ...caller, name: known.shownAs } : caller);
  }

  /** Stops everything it started, together, and lets go of what it opened. The database is the place's to close. */
  async stop(): Promise<void> {
    this.#stopFreshness?.();
    this.#stopContributions();
    this.#stopFreshness = null;
    this.configuration.stop();
    this.engine.stop();
    this.sampler.stop();
    this.presence.stop();
    this.occupancy.stop();
    this.modes.stop();
    this.changeLog.stop();
    this.setup.stop();
    this.nearby.stop();
    await Promise.allSettled([this.sessions.closeAll(), this.installed.transports.stopAll()]);
    this.#started = false;
  }
}

/** A family's hub, made from what the place gives it: `start()` it, ask it, `stop()` it. */
export const createHub = (options: HubOptions): Hub => new Hub(options);
