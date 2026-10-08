import { ApiError, type ElsewhereView, type ImportAnswers, type ImportApplied, type ImportPlan } from '@kraftverk/api-contract';
import { isSimulated, methodOf, randomHex } from '@kraftverk/device-sdk';
import { writeConfig, type Scalar } from '@kraftverk/home-file';
import { HomeSettings, NodeSettings, PlaceStore, AutomationStore, ConnectionStore, DeviceCatalog, LinkStore, NodeStore, policyValues, setPolicyValue, type NodeSettingKey, type SecretsAtRest, type SqlDatabase } from '@kraftverk/store';
import { ensureFirstHome, firstHomeLocation } from '../homes/homes.ts';

import { exportConfig, type ConfigDeps } from '../configuration/export.ts';
import type { PassphraseSealing } from '../configuration/seal.ts';
import { shouldLead } from '../node/lead.ts';
import { nothingToDo } from './nothing.ts';
import { holdableHere } from '../installed/holdable.ts';
import type { Follower } from '../follower/follower.ts';

/*
  This node's own home, moving to its master (docs/PLAN-SHARED-CORE.md,
  phase 6h): a person who began with the app alone adds a server, and that
  node, the master now, takes the home over — its devices, links, automations
  and values — through the configuration, as an import: planned, seen, and
  applied with a person's yes where it sets something acting. A way over a
  radio stays with the node near the device (a transport `nearby`:
  Bluetooth), and so does one the master cannot hold at all: the master
  keeps the device, and this node holds that way for it, its key never
  leaving this node. Every other way moves to the master, which holds it
  while the app is closed. What this node recorded stays with it: its
  history is not moved.
*/

/** Kept in this node's own home, once it has moved: not offered again. */
const MOVED: NodeSettingKey = 'family.moved';
/** This node's own home as moving reads it: the stores an export reads, and its own state. */
type OwnHome = ConfigDeps & { settings: NodeSettings };
/** A way that stays with this node: the device it reaches, and what this node needs to hold it for the master. */
type Staying = { key: string; name: string; typeId: string; method: string; label: string; address: string | null; settings: Record<string, Scalar>; device: Record<string, Scalar>; connection: string | null };

export class MovingToMaster {
  readonly #follower: Follower;
  readonly #database: SqlDatabase;
  readonly #secrets: SecretsAtRest;
  readonly #sealing: PassphraseSealing;
  #own: OwnHome | null = null;
  /** The plans made of the home, by the master's id: the ways that stay with this node. */
  readonly #plans = new Map<string, Staying[]>();

  /** `database`: the home this node kept itself, before it followed a master; `secrets`: this node's key, which sealed its secrets there. */
  constructor(follower: Follower, database: SqlDatabase, options: { secrets: SecretsAtRest; sealing: PassphraseSealing }) {
    this.#follower = follower;
    this.#database = database;
    this.#secrets = options.secrets;
    this.#sealing = options.sealing;
  }

  /**
   * This node's own home, read: its stores over the database it kept, and
   * nothing else — not a hub, so nothing in it runs, and nothing is written
   * to it but whether it has moved.
   */
  #home(): OwnHome {
    if (this.#own) return this.#own;
    const db = this.#database;
    const settings = new NodeSettings(db);
    const places = new PlaceStore(db);
    const policyHome = new HomeSettings(db, () => ensureFirstHome(places).id);
    const { types, protocols } = this.#follower.installed;
    this.#own = {
      settings,
      catalog: new DeviceCatalog(db),
      connections: new ConnectionStore(db, this.#secrets),
      links: new LinkStore(db),
      automations: new AutomationStore(db),
      // The same node: its own home was kept by it, before it followed one — by the id that database says it is.
      self: new NodeStore(db).self()?.id ?? this.#follower.nodeId,
      types,
      protocols,
      policy: { values: () => policyValues(policyHome), set: (name, value) => setPolicyValue(policyHome, name, value) },
      location: firstHomeLocation(places),
      sealing: this.#sealing,
      kept: this.#secrets,
    };
    return this.#own;
  }

  /** What moving would bring; null when there is nothing to, it has moved, or the master is no fitter for it than this node. */
  what(): ElsewhereView {
    const own = this.#home();
    if (own.settings.get(MOVED)) return null;
    const master = this.#follower.master();
    if (!master || !shouldLead(master, this.#follower.self)) return null;
    const devices = own.catalog.list().length;
    const automations = own.automations.list().length;
    return devices || automations ? { from: 'this-node', devices, automations } : null;
  }

  owns(plan: string): boolean {
    return this.#plans.has(plan);
  }

  /**
   * What moving would do on the master: the home as one file, its secrets
   * sealed with a passphrase made for it and never shown, planned there —
   * and what stays with this node, said.
   */
  async plan(mode: 'merge' | 'replace'): Promise<ImportPlan> {
    const own = this.#home();
    if (own.settings.get(MOVED)) throw new ApiError('not-found', 'This app’s own home has moved to your server already');
    const { installed } = this.#follower;
    const passphrase = randomHex(16);
    const { document } = await exportConfig(own, { secrets: 'sealed', passphrase });
    const offered = (await this.#follower.home.deviceTypes()).types;
    const staying: Staying[] = [];
    for (const [key, entry] of Object.entries(document.devices)) {
      const type = installed.types.get(entry.type);
      const theirs = new Set(offered.find((listing) => listing.id === entry.type)?.ways.filter((way) => way.holder === 'master' && way.fits).map((way) => way.method) ?? []);
      const had = own.catalog.byKey(key);
      entry.connect = entry.connect.filter((way) => {
        const method = type ? methodOf(type, way.via) : null;
        if (!method || isSimulated(method)) return true;
        const nearby = installed.transports.definition(method.transport)?.nearby === true;
        // Near the device, or a way the master cannot hold: this node holds it for the master, if it can.
        if (!(nearby || !theirs.has(method.id)) || !holdableHere(installed, this.#follower.self, method)) return true;
        const connection = had ? (own.connections.forDevice(had.id).find((each) => each.method === method.id && each.heldBy === own.self) ?? null) : null;
        staying.push({ key, name: entry.name, typeId: entry.type, method: method.id, label: method.label, address: connection?.address ?? way.address, settings: way.settings, device: entry.settings, connection: connection?.id ?? null });
        // Its secrets stay with this node: out of the file, and out of what the file names.
        for (const secret of Object.values(way.secrets)) if ('secret' in secret) delete document.secrets[secret.secret];
        return false;
      });
    }
    const plan = await this.#follower.home.configuration.plan({ text: writeConfig(document), mode, passphrase });
    if (plan.id) this.#plans.set(plan.id, staying);
    // All of it is on the master already, and nothing stays to be added: there is nothing to move, and it is not offered again.
    if (nothingToDo(plan) && !staying.length) own.settings.set(MOVED, new Date().toISOString());
    return {
      ...plan,
      notes: [
        ...plan.notes,
        ...staying.map((stay) => `${stay.name}: ${stay.label} stays with ${this.#follower.name}, near it — your server keeps the device`),
        'What this app recorded stays with it: its history does not move.',
      ],
    };
  }

  /**
   * Moves it: the master applies the plan — with a person's yes where it
   * asks one — then this node adds the ways it keeps, as it adds any way it
   * holds for the master: read by this node, judged there as the device it
   * now has, saved. Their secrets are kept here. What could not stay is said.
   */
  async apply(answers: ImportAnswers): Promise<ImportApplied> {
    const staying = this.#plans.get(answers.plan) ?? [];
    const follower = this.#follower;
    const applied = await follower.home.configuration.apply(answers);
    this.#plans.delete(answers.plan);
    const own = this.#home();
    const me = await follower.joined();
    const list = await follower.home.devices.list();
    const kept: { way: string; secrets: Record<string, string> }[] = [];
    for (const stay of staying) {
      const device = list.find((each) => each.key === stay.key && !each.removedAt);
      if (!device || !stay.address) {
        applied.notes.push(`${stay.name}: its ${stay.label} could not stay with this app: add it again from ${follower.name}`);
        continue;
      }
      try {
        const draft = await follower.home.setup.startHeld({
          nodeId: me,
          typeId: stay.typeId,
          methodId: stay.method,
          address: stay.address,
          identified: { identity: device.identity, model: null, summary: `Moved from ${follower.name}` },
          device: stay.device,
          connection: stay.settings,
        });
        const saved = await follower.home.setup.save(draft.id, { mode: 'attach', deviceId: device.id, name: device.name });
        const way = saved.connections.find((each) => each.method === stay.method && each.heldBy.id === me);
        if (way && stay.connection) {
          kept.push({ way: way.id, secrets: own.connections.secrets(stay.connection) });
        }
      } catch (error) {
        applied.notes.push(`${stay.name}: its ${stay.label} could not stay with this app: ${(error as Error).message}`);
      }
    }
    // Held from now on, its keys here.
    await follower.refresh();
    for (const { way, secrets } of kept) if (Object.keys(secrets).length) await follower.setSecrets(way, secrets);
    own.settings.set(MOVED, new Date().toISOString());
    return applied;
  }
}
