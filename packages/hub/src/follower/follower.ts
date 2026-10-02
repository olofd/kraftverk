import { ApiError, type ConnectionView, type DeviceView, type KraftverkApi, type PolicyValueView } from '@kraftverk/api-contract';
import { isPolicyValueName, type AuditRecord, type DeviceSession, type DeviceStore, type NodeId, type Platform, type PolicyValues, type Reading, type SavedDeviceId, type ScopedHttp } from '@kraftverk/device-sdk';
import { ActionGateway, Confirmations } from '@kraftverk/gateway';
import { LiveBus, SessionManager, toHold, toolsOf, withInUse, type DeviceEventMessage } from '@kraftverk/holder';
import { ConnectionStore, DeviceCatalog, deviceStore, HomeSettings, HomeStore, LastHeard, LinkStore, NodeStore, SendQueue, type DeviceRecord, type NodeDeclaration, type NodeRecord, type SecretsAtRest, type SqlDatabase } from '@kraftverk/store';

import type { PassphraseSealing } from '../configuration/seal.ts';
import { MovingToMaster } from '../handover/move.ts';
import { startTransports, type Installed } from '../installed/from.ts';
import { FIRST_PICTURE } from '../devices/views.ts';
import { nodeParts } from '../node/parts.ts';
import { SetupService } from '../setup/service.ts';
import { unref } from '../timers.ts';
import { followerApi } from './api.ts';
import { HEARD } from './heard.ts';

/**
 * A node following the home's master (docs/PLAN-SHARED-CORE.md, phase 6):
 * this node, in a home whose master is another — the one its people use,
 * always on and reached by others. The master keeps the devices, their
 * history and their automations; this node keeps a copy of what it says —
 * the home and its nodes among it — and holds for it the ways in to its
 * devices that this node reaches itself — its own Bluetooth — beside the
 * master's, with the same session manager and the same gateway the home
 * runs, sending what they say to the master, queued while it is away.
 *
 * Its `api` is the master's `KraftverkApi` with what this node holds wrapped
 * in: a view carries this node's own readings for a device it holds, a
 * command to one goes through this node's gateway, a way it holds is set up
 * here, its secrets kept here. The screens ask it as they ask any home.
 *
 * What it keeps is kept in this node's own database: the devices it holds a
 * way to, as the master has them; that way's secrets, sealed; what each
 * device's session keeps; the gateway's memory; what is owed to the
 * master; and what the master last said (`heard`). A restart loses none of
 * it, and with the master away this node still reaches what it holds, and
 * shows the rest as the master last said it — read only, and saying so.
 */

/** How often what is owed is sent, and how often the master is asked what this node holds. */
const SEND_MS = 20_000;
const REFRESH_MS = 5 * 60_000;
/** At most this many of each kind are kept owed, the newest: a master away for weeks does not fill a phone that follows it. */
const KEEP_OWED = { readings: 10_000, event: 1000, audit: 1000, store: 1000 } as const;
/** At most this many readings go up in one call. */
const READINGS_PER_CALL = 2000;
/** What the master refuses for good — no such device, not this node's, too large — is not sent again. */
const REFUSED_FOR_GOOD = new Set(['not-found', 'forbidden', 'conflict', 'invalid', 'too-large', 'not-allowed']);

export type FollowerOptions = {
  /** The home's master, as the person signed in asks it. */
  home: KraftverkApi;
  /** This node's own database for it, its schema prepared: where what the follower keeps is kept. */
  database: SqlDatabase;
  /** How the secrets of the ways it holds are sealed at rest: this node's key. */
  secrets: SecretsAtRest;
  /** What this node has installed, and its transports where it runs. */
  installed: Installed;
  /**
   * The node this is: its id — the place's to keep, the same in every home
   * it is part of — its name, and what it declares it is. Its database is
   * this node's; it joins the home by this id.
   */
  node: Omit<NodeDeclaration, 'platform' | 'transports'>;
  /** Every write to hardware refused: until someone allows writes from this node. A simulated device reaches no hardware. */
  readOnly: () => boolean;
  /** For a setup helper that calls a vendor's API once — fetching a key. */
  http: ScopedHttp;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** How often what is owed is sent: a test's own. */
  sendEveryMs?: number;
  /**
   * The home this node kept itself before it followed this master, if it
   * did: offered to the master to take over (`configuration.plan({ from:
   * 'this-node' })`), with the cipher its secrets travel sealed with.
   */
  own?: { database: SqlDatabase; sealing: PassphraseSealing };
};

/** What goes up with a device's readings: the way it was read by, who it said it is, and what it is when it says so itself. */
type ReadingsOwed = { connectionId: string; identity: string | null; readings: Reading[]; description?: DeviceView['description']; info?: DeviceView['info'] };
type EventOwed = { connectionId: string; event: DeviceEventMessage };
type StoreOwed = { connectionId: string; key: string; value: unknown };

export class Follower {
  readonly home: KraftverkApi;
  readonly db: SqlDatabase;
  readonly installed: Installed;
  readonly readOnly: () => boolean;
  /** This node, as its own database knows it. */
  readonly nodes: NodeStore;
  /** The home as the master has it: its name, and which node is its master. */
  readonly homeKept: HomeStore;

  readonly settings: HomeSettings;
  readonly catalog: DeviceCatalog;
  readonly connections: ConnectionStore;
  readonly links: LinkStore;
  readonly queue: SendQueue;
  /** What the master last said, by what was asked: shown while it cannot be reached. */
  readonly heard: LastHeard;
  readonly bus: LiveBus;
  readonly sessions: SessionManager;
  readonly gateway: ActionGateway;
  readonly setup: SetupService;
  /** The tokens a person's yes to a tool that cannot be undone is sent back with. */
  readonly yes = new Confirmations();
  /** Everything the master answers, with what this node holds wrapped in. */
  readonly api: KraftverkApi;
  /** The home this node kept itself, moving to the master: none when it kept none. */
  readonly moving: MovingToMaster | null;

  /** The master's last word on each device: what the gateway checks against for one this node does not hold. */
  #seen = new Map<SavedDeviceId, DeviceView>();
  /** The devices whose way this node should hold now: its own, while nothing above it reaches them. */
  #holdNow = new Set<SavedDeviceId>();
  /** Per device and reading, the minute last owed: history keeps one a minute. */
  #owedMinute = new Map<string, number>();
  #describedOwed = new Map<string, string>();
  #log: NonNullable<FollowerOptions['log']>;
  #timers: ReturnType<typeof setInterval>[] = [];
  /** Whether the home has heard who this node is, this run. */
  #joined = false;
  #sending: Promise<void> | null = null;
  #sendEveryMs: number;
  /** The last list held, one after the other. */
  #holding: Promise<void> = Promise.resolve();
  /** What the last list held came to, as written: the same again is not written again. Null, written since by something else. */
  #heldAs: string | null = null;

  constructor(options: FollowerOptions) {
    const db = options.database;
    this.home = options.home;
    this.db = db;
    this.installed = options.installed;
    this.readOnly = options.readOnly;
    this.#sendEveryMs = options.sendEveryMs ?? SEND_MS;
    this.#log = options.log ?? ((level, message) => console[level === 'info' ? 'log' : level](message));

    this.queue = new SendQueue(db);
    this.homeKept = new HomeStore(db);
    this.heard = new LastHeard(db);
    // Its timeline is owed to the master, sent with its readings.
    const record = (entry: AuditRecord) => this.owe('audit', null, entry);

    // What every node is made of, as a follower: the ways it holds for the master, held while nothing above reaches the device.
    const parts = nodeParts(
      { database: db, secrets: options.secrets, installed: options.installed, node: options.node, readOnly: options.readOnly, http: options.http, log: this.#log },
      {
        tag: 'follower',
        record,
        ways: ({ connections }) => ({
          // Every way kept here is this node's own; it is held while nothing above it reaches the device.
          connections: (deviceId) => (this.#holdNow.has(deviceId) ? connections.forDevice(deviceId) : []),
          holds: () => true,
          secret: (connectionId, field) => connections.secret(connectionId, field),
          secretFields: (connectionId) => connections.secretFields(connectionId),
          onConnected: (connectionId) => connections.touch(connectionId),
        }),
        sessions: {
          store: (deviceId) => this.#storeOf(deviceId),
          // Kept by the master, as its own devices' are: sent with the readings.
          onEvent: (deviceId, event) => {
            const connection = this.sessions.inUse(deviceId);
            if (connection) this.owe('event', deviceId, { connectionId: connection.id, event } satisfies EventOwed);
          },
        },
        /** Over what this node holds — and the master's word on what it does not, to verify a switch against. */
        gateway: ({ catalog, sessions }) => ({
          device: (id) => {
            const seen = this.#seen.get(id);
            const held = catalog.active(id);
            if (held && this.#holdNow.has(id)) return { name: held.name, session: sessions.get(id), description: sessions.description(held), offline: sessions.health(held).detail };
            return seen ? { name: seen.name, session: viewSession(seen), description: seen.description, offline: seen.health.detail } : null;
          },
          linksFrom: (id, part) =>
            (this.#seen.get(id)?.links ?? []).filter((link) => link.role === 'source' && link.part === part).map((link) => ({ kind: link.kind, target: { device: link.other.id, part: link.other.part } })),
          readOnlyReason: 'Writes from this app are off: allow them in App settings',
          policyValues: () => this.policyValues(),
        }),
      }
    );
    ({ settings: this.settings, catalog: this.catalog, connections: this.connections, links: this.links, nodes: this.nodes, bus: this.bus, sessions: this.sessions, gateway: this.gateway, setup: this.setup } = parts);
    this.moving = options.own ? new MovingToMaster(this, options.own.database, { secrets: options.secrets, sealing: options.own.sealing }) : null;
    this.api = followerApi(this);
  }

  /** This node, as it declared itself: its id, its name and what it is. */
  get self(): NodeRecord {
    return this.nodes.self()!;
  }

  /** This node: the id it joins the home by, and holds its ways under. */
  get nodeId(): NodeId {
    return this.self.id;
  }

  /** What this node is called, in "held by …". */
  get name(): string {
    return this.self.name;
  }

  /** Where this node runs: what its transports' entries are for. */
  get platform(): Platform {
    return this.installed.transports.platform;
  }

  /**
   * Starts following: the transports this node runs, who it is to the master,
   * what it holds there — or, with the master away, what it held when it
   * last heard — and sending what is owed.
   */
  async start(): Promise<void> {
    await startTransports(this.installed, this.#log);
    await this.join().catch((error: unknown) => this.#log('warn', `[follower] the master did not hear who this node is: ${(error as Error).message}`));
    const list = await this.refresh();
    if (!list) {
      // Away: what this node held when it last heard, it holds still.
      this.#holdNow = new Set(this.catalog.list().map((device) => device.id));
      await this.sessions.sync(this.catalog.list());
    }
    // The home's values, kept as the master says them: what this node's gateway weighs what it holds by.
    await this.kept(HEARD.policy, () => this.home.policy.list()).catch(() => undefined);
    const send = setInterval(() => void this.send(), this.#sendEveryMs);
    const refresh = setInterval(() => void this.refresh(), REFRESH_MS);
    unref(send);
    unref(refresh);
    this.#timers = [send, refresh];
  }

  async stop(): Promise<void> {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    this.setup.stop();
    await this.send().catch(() => undefined);
    await Promise.allSettled([this.sessions.closeAll(), this.installed.transports.stopAll()]);
  }


  /** Joins the home — says who this node is, what it is and what it reaches devices over — at every start, by its own id. */
  async join(): Promise<NodeId> {
    const self = this.nodes.self()!;
    await this.home.nodes.join({ id: self.id, name: self.name, platform: self.platform, transports: this.installed.transports.here(), alwaysOn: self.alwaysOn, reachable: self.reachable, trusted: self.trusted });
    this.#joined = true;
    return self.id;
  }

  /** This node, once the home has heard it this run: joined now if it had not, as the master was away at the start. */
  async joined(): Promise<NodeId> {
    return this.#joined ? this.nodeId : this.join();
  }

  /** Asks the master what it has, keeps what it said, and holds what is this node's to hold. Null when it cannot be asked. */
  async refresh(): Promise<DeviceView[] | null> {
    try {
      // Not heard at the start — the master away, or nobody signed in yet: said again now.
      if (!this.#joined) await this.join().catch(() => undefined);
      const list = await this.home.devices.list();
      this.heard.keep(HEARD.devices, list);
      await this.keepHome().catch((error: unknown) => this.#log('warn', `[follower] the home and its nodes could not be kept: ${(error as Error).message}`));
      await this.hold(list);
      // The home as one file, as the master last said it: what this node keeps if the master is gone (`handover/keep.ts`).
      await this.home.configuration
        .export({ secrets: 'none' })
        .then((exported) => this.heard.keep(HEARD.configuration, exported.text))
        .catch(() => undefined);
      return list;
    } catch (error) {
      // Away is the master out of reach, or saying it cannot answer now; anything else is a fault, said as one — and held as away all the same, so what this node holds goes on.
      if (!(error instanceof ApiError && error.kind === 'unavailable')) this.#log('error', `[follower] asking the master what it has failed: ${(error as Error).stack ?? error}`);
      return null;
    }
  }

  /**
   * Asks the master, and keeps what it answers; with the master out of
   * reach, what it last answered, and when — or, never heard, the refusal.
   * Anything else the master says no to is said as it is.
   */
  async kept<T>(what: string, ask: () => Promise<T>): Promise<{ answer: T; heardAt: string | null }> {
    try {
      const answer = await ask();
      this.heard.keep(what, answer);
      return { answer, heardAt: null };
    } catch (error) {
      const last = error instanceof ApiError && error.kind === 'unavailable' ? this.heard.get<T>(what) : null;
      if (!last) throw error;
      return { answer: last.body, heardAt: last.heardAt };
    }
  }

  /**
   * A device as the master last said it, while it cannot be reached: what it
   * read then, and its health saying so — unless this node holds it, and
   * says how it is now.
   */
  lastHeard(device: DeviceView): DeviceView {
    if (this.holds(device.id)) return device;
    return { ...device, health: { ...device.health, status: 'offline', detail: 'Your server cannot be reached: this is what it last said' }, connections: device.connections.map((connection) => ({ ...connection, reachable: null })) };
  }

  /**
   * The home and its nodes as the master has them, kept here: which node is
   * its master, what each declares it is, and who holds what. A node the
   * master no longer has is let go; this one is its own, and stays — and,
   * forgotten there, joins again.
   *
   * In one go, in the order the home's master needs: every node as the
   * master has it first, then the home naming its master — a new one, when
   * the machine behind the address is another now — and only then the nodes
   * it no longer has, the old master among them.
   */
  async keepHome(): Promise<void> {
    const [home, nodes] = await Promise.all([this.home.home(), this.home.nodes.list()]);
    this.db.transaction(() => {
      for (const node of nodes) {
        const { master: _master, yours: _yours, ...record } = node;
        this.nodes.mirror(record);
      }
      this.homeKept.mirror({ id: home.id, name: home.name, masterId: home.master, createdAt: home.createdAt });
      const listed = new Set(nodes.map((node) => node.id));
      for (const kept of this.nodes.all()) if (!kept.self && !listed.has(kept.id)) this.nodes.remove(kept.id);
    })();
    // Forgotten there while it ran: it says who it is again, now.
    if (!nodes.some((node) => node.id === this.nodeId)) {
      this.#joined = false;
      await this.join().catch((error: unknown) => this.#log('warn', `[follower] the master did not hear who this node is: ${(error as Error).message}`));
    }
  }

  /** The master this node follows, as it declared itself when last heard; null before it was. */
  master(): NodeRecord | null {
    const home = this.homeKept.get();
    return home ? this.nodes.get(home.masterId) : null;
  }

  /**
   * Holds, of what the master listed, what is this node's: a device with a
   * way this node holds is kept here as the master has it, and that way is
   * held while nothing above it reaches the device (`toHold`). A device it
   * no longer has a way to is let go, with what was kept for it.
   */
  hold(list: readonly DeviceView[]): Promise<void> {
    // One at a time: two lists heard together are held in the order they came.
    const held = this.#holding.then(() => this.#hold(list));
    this.#holding = held.catch(() => undefined);
    return held;
  }

  async #hold(list: readonly DeviceView[]): Promise<void> {
    const me = this.nodeId;
    // Never two writers: a node does not follow itself, whatever it was told.
    if (this.master()?.id === me) {
      this.#log('error', '[follower] the master named is this node itself: it holds nothing for it');
      list = [];
    }
    this.#seen = new Map(list.map((device) => [device.id, device]));
    const mine = list.filter((device) => device.connections.some((connection) => this.#mine(connection, me)));
    const kept = mine.map((device) => ({
      record: recordOf(device),
      ways: device.connections.filter((connection) => this.#mine(connection, me)).map((way) => ({ ...way, heldBy: way.heldBy.id, deviceId: device.id, createdAt: device.addedAt })),
    }));
    const holdNow = mine.filter((device) => toHold(device, me)).map((device) => device.id);
    // As it was last written, nothing is written again: a screen reading the list every few seconds costs a comparison, not a rewrite.
    const as = JSON.stringify([kept, holdNow]);
    if (as === this.#heldAs) return;
    this.#heldAs = null;

    const keep = new Set(mine.map((device) => device.id));
    for (const device of this.catalog.list()) {
      if (keep.has(device.id)) continue;
      await this.sessions.close(device.id);
      this.catalog.deleteForever(device.id);
    }
    for (const { record, ways } of kept) {
      this.catalog.mirror(record);
      for (const gone of this.connections.forDevice(record.id)) if (!ways.some((way) => way.id === gone.id)) this.connections.remove(gone.id);
      for (const way of ways) this.connections.mirror(way);
    }
    this.#holdNow = new Set(holdNow);
    await this.sessions.sync(this.catalog.list());
    this.#heldAs = as;
  }

  /** Whether a way is this node's own. */
  #mine(connection: ConnectionView, me: NodeId): boolean {
    return connection.heldBy.id === me;
  }

  /** Whether this node holds a device now: a session of its own is open for it, or about to be. */
  holds(deviceId: SavedDeviceId): boolean {
    return this.#holdNow.has(deviceId) && this.catalog.active(deviceId) !== null;
  }

  /** Whether a way is one this node holds. */
  owns(connectionId: string): boolean {
    return this.connections.get(connectionId) !== null;
  }

  /**
   * A device as the master says it, with what this node knows first: a way
   * this node holds is said to be its own, with the secrets it keeps; and
   * while it holds the device, its readings, health and tools are this
   * node's, read just now.
   */
  view(device: DeviceView): DeviceView {
    const me = this.nodeId;
    const connections = device.connections.map((connection) =>
      this.#mine(connection, me) ? { ...connection, heldBy: { kind: 'this-node' as const, id: me, name: this.name }, secrets: this.connections.secretFields(connection.id) } : connection
    );
    const held = this.catalog.active(device.id);
    if (!held || !this.#holdNow.has(device.id)) return { ...device, connections };
    const session = this.sessions.get(device.id);
    const health = this.sessions.health(held);
    const inUse = this.sessions.inUse(device.id) ?? this.connections.forDevice(device.id)[0] ?? null;
    return {
      ...device,
      readings: session?.readings() ?? device.readings,
      health,
      tools: session ? toolsOf(this.installed.types.get(device.typeId)?.tools, session).map(({ name, spec }) => ({ name, ...spec })) : device.tools,
      // Held here: whether writes are refused is this node's own switch.
      readOnly: this.readOnly() && !this.sessions.simulated(device.id),
      // What this node holds, it knows first: whether its own way reaches the device.
      connections: withInUse(
        connections.map((connection) => (connection.id === inUse?.id ? { ...connection, reachable: health.status === 'connected' } : connection)),
        inUse?.id ?? null
      ),
    };
  }

  /** A way's secrets, kept here and never sent: write-only, and held to what its method declares. */
  async setSecrets(connectionId: string, secrets: Record<string, string>): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) throw new ApiError('not-found', 'No such connection');
    this.connections.setSecrets(connectionId, secrets);
    // Reopened, so the new key is used now.
    await this.sessions.close(connection.deviceId);
    await this.sessions.sync(this.catalog.list());
  }

  /** Lets go of a device the master no longer has, or no longer has a way of this node's to. */
  async forget(deviceId: SavedDeviceId): Promise<void> {
    this.#heldAs = null;
    await this.sessions.close(deviceId);
    if (this.catalog.get(deviceId)) this.catalog.deleteForever(deviceId);
    this.#holdNow.delete(deviceId);
  }

  /** Writes allowed or refused again: sessions reopen under the new rule. */
  async reopen(): Promise<void> {
    for (const device of this.catalog.list()) await this.sessions.close(device.id);
    await this.sessions.sync(this.catalog.list());
  }

  /** How much is a load, and the other values the home decides: the master's, kept for when it cannot be asked. */
  policyValues(): PolicyValues {
    try {
      const values = this.heard.get<PolicyValueView[]>(HEARD.policy)?.body ?? [];
      return Object.fromEntries(values.filter((value) => isPolicyValueName(value.name) && Number.isFinite(value.value)).map((value) => [value.name, value.value]));
    } catch {
      return {};
    }
  }

  // --- what is owed to the master -------------------------------------------------

  /** Owed to the master, kept until it has it. */
  owe(kind: 'readings' | 'event' | 'audit' | 'store', deviceId: string | null, body: unknown): void {
    // The master adds who sent it: what it is about goes as it is.
    const owed = kind === 'audit' ? (({ actor: _actor, ...entry }: AuditRecord) => entry)(body as AuditRecord) : body;
    this.queue.add(kind, deviceId, owed);
    this.queue.trim(kind, KEEP_OWED[kind]);
  }

  /** What a device's session keeps: here, and owed to the master, which keeps it with the device. */
  #storeOf(deviceId: SavedDeviceId): DeviceStore {
    const here = deviceStore(this.db, deviceId);
    const owe = (key: string, value: unknown) => {
      const connection = this.sessions.inUse(deviceId) ?? this.connections.forDevice(deviceId)[0];
      if (connection) this.owe('store', deviceId, { connectionId: connection.id, key, value } satisfies StoreOwed);
    };
    return {
      get: (key) => here.get(key),
      set: (key, value) => {
        here.set(key, value);
        owe(key, value);
      },
      delete: (key) => {
        here.delete(key);
        owe(key, null);
      },
    };
  }

  /** What each device this node holds has read since it was last owed: one a minute per reading, as history keeps it. */
  #collect(): void {
    for (const deviceId of this.sessions.opened()) {
      const session = this.sessions.get(deviceId);
      const connection = this.sessions.inUse(deviceId);
      const record = this.catalog.active(deviceId);
      if (!session || !connection || !record) continue;
      const readings = session.readings().filter((reading) => {
        if (!reading.at || reading.value === null) return false;
        const minute = Math.floor(Date.parse(reading.at) / 60_000);
        const key = `${deviceId}:${reading.key}`;
        if (this.#owedMinute.get(key) === minute) return false;
        this.#owedMinute.set(key, minute);
        return true;
      });
      // Only a device's own description goes: its type's the master has from when it was added.
      const own = this.sessions.describedBy(record) === 'device' ? this.sessions.description(record) : null;
      const said = own ? JSON.stringify(own) : null;
      const describe = said !== null && said !== this.#describedOwed.get(deviceId);
      if (!readings.length && !describe) continue;
      if (describe) this.#describedOwed.set(deviceId, said);
      this.owe('readings', deviceId, {
        connectionId: connection.id,
        identity: session.identity?.().id ?? null,
        readings,
        ...(describe ? { description: own!, info: this.sessions.info(record) } : {}),
      } satisfies ReadingsOwed);
    }
  }

  /**
   * Sends what is owed, in order: the timeline, each device's readings and
   * events together, what sessions kept. What the master cannot take now
   * waits for the next time; what it refuses for good is let go. One send at
   * a time; one asked for while another runs waits for it.
   */
  send(): Promise<void> {
    this.#sending ??= this.#send().finally(() => {
      this.#sending = null;
    });
    return this.#sending;
  }

  async #send(): Promise<void> {
    this.#collect();
    const me = this.nodeId;
    const owed = this.queue.next(1000);
    /** Sent, or refused for good: true; the master away: false, and the rest waits. */
    const attempt = async (ids: number[], work: () => Promise<unknown>): Promise<boolean> => {
      try {
        await work();
        this.queue.done(ids);
        return true;
      } catch (error) {
        if (error instanceof ApiError && REFUSED_FOR_GOOD.has(error.kind)) {
          this.#log('warn', `[follower] the master refused what this node sent: ${error.message}`);
          this.queue.done(ids);
          return true;
        }
        return false;
      }
    };

    const audit = owed.filter((each) => each.kind === 'audit');
    if (audit.length && !(await attempt(audit.map((each) => each.id), () => this.home.held.audit(me, audit.map((each) => each.body as never))))) return;

    const byDevice = new Map<string, typeof owed>();
    for (const each of owed) if ((each.kind === 'readings' || each.kind === 'event') && each.deviceId) byDevice.set(each.deviceId, [...(byDevice.get(each.deviceId) ?? []), each]);
    for (const [deviceId, rows] of byDevice) {
      const sending: typeof rows = [];
      let count = 0;
      for (const row of rows) {
        const size = row.kind === 'readings' ? (row.body as ReadingsOwed).readings.length : 1;
        if (sending.length && count + size > READINGS_PER_CALL) break;
        sending.push(row);
        count += size;
      }
      const readings = sending.filter((row) => row.kind === 'readings').map((row) => row.body as ReadingsOwed);
      const events = sending.filter((row) => row.kind === 'event').map((row) => (row.body as EventOwed).event);
      const last = (readings.at(-1) ?? null) as ReadingsOwed | null;
      const described = [...readings].reverse().find((each) => each.description);
      const connectionId = last?.connectionId ?? (sending.at(-1)!.body as EventOwed).connectionId;
      const sent = await attempt(
        sending.map((row) => row.id),
        () =>
          this.home.held.readings(deviceId as SavedDeviceId, {
            nodeId: me,
            connectionId,
            identity: [...readings].reverse().find((each) => each.identity)?.identity ?? null,
            readings: readings.flatMap((each) => each.readings),
            ...(described?.description ? { description: described.description, info: described.info ?? null } : {}),
            ...(events.length ? { events: events.map((event) => ({ id: event.id, part: event.part, data: event.data as never, at: event.at })) } : {}),
          })
      );
      if (!sent) return;
    }

    for (const row of owed.filter((each) => each.kind === 'store' && each.deviceId)) {
      const { connectionId, key, value } = row.body as StoreOwed;
      if (!(await attempt([row.id], () => this.home.held.keep(row.deviceId as SavedDeviceId, key, { nodeId: me, connectionId, value })))) return;
    }
  }
}

/**
 * A device this node does not hold, as the gateway sees it: what the master
 * says it reads. Enough to verify a switch against a station the master
 * holds — its mains presence is a standard meaning, whoever reads it. It
 * takes no commands from here.
 */
function viewSession(device: DeviceView): DeviceSession {
  return {
    health: () => device.health,
    readings: () => device.readings,
    command: async () => ({ accepted: false, error: 'This app does not hold that device' }),
    close: async () => {},
  };
}

/** A device as the master has it, as it is kept here. */
function recordOf(device: DeviceView): DeviceRecord {
  return {
    id: device.id,
    key: device.key,
    typeId: device.typeId,
    identity: device.identity,
    name: device.name,
    config: device.config,
    addedAt: device.addedAt,
    removedAt: device.removedAt,
    description: device.description,
    descriptionSource: device.descriptionSource,
    info: device.info,
    picture: device.picture === FIRST_PICTURE ? null : device.picture,
  };
}

/** What a node holds for the home's master, made from what the place gives it: `start()` it, ask its `api`, `stop()` it. */
export const createFollower = (options: FollowerOptions): Follower => new Follower(options);
