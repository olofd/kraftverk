import { ApiError, type ElsewhereView, type ImportAnswers, type ImportApplied, type ImportPlan } from '@kraftverk/api-contract';
import { isSimulated, methodOf } from '@kraftverk/device-sdk';
import { writeConfig, type Scalar } from '@kraftverk/home-file';
import { randomHex, type SecretsAtRest, type SqlDatabase } from '@kraftverk/store';

import type { PassphraseSealing } from '../configuration/seal.ts';
import { createHub, type Hub } from '../hub.ts';
import { nothingToDo } from './nothing.ts';
import { holdableHere } from '../holding/holdable.ts';
import type { Holding } from '../holding/holding.ts';

/*
  This app's own home, moving to its server (docs/PLAN-SHARED-CORE.md,
  phase 6h): a person who began with the app alone adds a server, and the
  server takes the home over — its devices, links, automations and values
  — through the configuration, as an import: planned, seen, and applied with
  a person's yes where it sets something acting. A way over a radio stays
  with the phone near the device (a transport `nearby`: Bluetooth), and so
  does one the server cannot hold at all: the server keeps the device, and
  this app holds that way for it, its key never leaving the app. Every
  other way moves to the server, which holds it while the app is closed.
  What the app recorded stays with it: its history is not moved.
*/

/** Kept in the app's own home, once it has moved: not offered again. */
const MOVED = 'home.moved';
/** A way that stays with this app: the device it reaches, and what this app needs to hold it for the server. */
type Staying = { key: string; name: string; typeId: string; method: string; label: string; address: string | null; settings: Record<string, Scalar>; device: Record<string, Scalar>; connection: string | null };

export class MovingToServer {
  readonly #holding: Holding;
  readonly #database: SqlDatabase;
  readonly #secrets: SecretsAtRest;
  readonly #sealing: PassphraseSealing;
  #own: Hub | null = null;
  /** The plans made of the home, by the server's id: the ways that stay with this app. */
  readonly #plans = new Map<string, Staying[]>();

  /** `database`: the home this app kept itself, before it had a server; `secrets`: this app's key, which sealed its secrets there. */
  constructor(holding: Holding, database: SqlDatabase, options: { secrets: SecretsAtRest; sealing: PassphraseSealing }) {
    this.#holding = holding;
    this.#database = database;
    this.#secrets = options.secrets;
    this.#sealing = options.sealing;
  }

  /** The app's own home, read: made from its database, never started — nothing in it runs while it moves. */
  #home(): Hub {
    this.#own ??= createHub({
      database: this.#database,
      secrets: this.#secrets,
      sealing: this.#sealing,
      installed: this.#holding.installed,
      // The same node: its own home was kept by it, before it followed one.
      node: (({ id, name, alwaysOn, reachable, trusted }) => ({ id, name, alwaysOn, reachable, trusted }))(this.#holding.nodes.self()!),
      readOnly: () => true,
      http: () => Promise.reject(new Error('A home moving reaches nothing')),
      log: () => {},
    });
    return this.#own;
  }

  /** What moving would bring; null when there is nothing to, or it has moved. */
  what(): ElsewhereView {
    const own = this.#home();
    if (own.state.get(MOVED)) return null;
    const devices = own.catalog.list().length;
    const automations = own.automations.list().length;
    return devices || automations ? { from: 'this-node', devices, automations } : null;
  }

  owns(plan: string): boolean {
    return this.#plans.has(plan);
  }

  /**
   * What moving would do on the server: the home as one file, its secrets
   * sealed with a passphrase made for it and never shown, planned there —
   * and what stays with this app, said.
   */
  async plan(mode: 'merge' | 'replace'): Promise<ImportPlan> {
    const own = this.#home();
    if (own.state.get(MOVED)) throw new ApiError('not-found', 'This app’s own home has moved to your server already');
    const { installed } = this.#holding;
    const passphrase = randomHex(16);
    const { document, context } = await own.configuration.document({ secrets: 'sealed', passphrase });
    const offered = (await this.#holding.home.deviceTypes()).types;
    const staying: Staying[] = [];
    for (const [key, entry] of Object.entries(document.devices)) {
      const type = installed.types.get(entry.type);
      const theirs = new Set(offered.find((listing) => listing.id === entry.type)?.ways.filter((way) => way.holder === 'master').map((way) => way.method) ?? []);
      const had = own.catalog.byKey(key);
      entry.connect = entry.connect.filter((way) => {
        const method = type ? methodOf(type, way.via) : null;
        if (!method || isSimulated(method)) return true;
        const nearby = installed.transports.definition(method.transport)?.nearby === true;
        // Near the device, or a way the server cannot hold: this app holds it for the server, if it can.
        if (!(nearby || !theirs.has(method.id)) || !holdableHere(installed, method)) return true;
        const connection = had ? (own.connections.forDevice(had.id).find((each) => each.method === method.id && each.heldBy === own.self.id) ?? null) : null;
        staying.push({ key, name: entry.name, typeId: entry.type, method: method.id, label: method.label, address: connection?.address ?? way.address, settings: way.settings, device: entry.settings, connection: connection?.id ?? null });
        // Its secrets stay with this app: out of the file, and out of what the file names.
        for (const secret of Object.values(way.secrets)) if ('secret' in secret) delete document.secrets[secret.secret];
        return false;
      });
    }
    const plan = await this.#holding.home.configuration.plan({ text: writeConfig(document, context), mode, passphrase });
    if (plan.id) this.#plans.set(plan.id, staying);
    // All of it is on the server already, and nothing stays to be added: there is nothing to move, and it is not offered again.
    if (nothingToDo(plan) && !staying.length) own.state.set(MOVED, new Date().toISOString());
    return {
      ...plan,
      notes: [
        ...plan.notes,
        ...staying.map((stay) => `${stay.name}: ${stay.label} stays with ${this.#holding.name}, near it — your server keeps the device`),
        'What this app recorded stays with it: its history does not move.',
      ],
    };
  }

  /**
   * Moves it: the server applies the plan — with a person's yes where it
   * asks one — then this app adds the ways it keeps, as it adds any way it
   * holds for the server: read by this app, judged there as the device it
   * now has, saved. Their secrets are kept here. What could not stay is said.
   */
  async apply(answers: ImportAnswers): Promise<ImportApplied> {
    const staying = this.#plans.get(answers.plan) ?? [];
    const holding = this.#holding;
    const applied = await holding.home.configuration.apply(answers);
    this.#plans.delete(answers.plan);
    const own = this.#home();
    const me = await holding.joined();
    const list = await holding.home.devices.list();
    const kept: { way: string; secrets: Record<string, string> }[] = [];
    for (const stay of staying) {
      const device = list.find((each) => each.key === stay.key && !each.removedAt);
      if (!device || !stay.address) {
        applied.notes.push(`${stay.name}: its ${stay.label} could not stay with this app: add it again from ${holding.name}`);
        continue;
      }
      try {
        const draft = await holding.home.setup.startHeld({
          nodeId: me,
          typeId: stay.typeId,
          methodId: stay.method,
          address: stay.address,
          identified: { identity: device.identity, model: null, summary: `Moved from ${holding.name}` },
          device: stay.device,
          connection: stay.settings,
        });
        const saved = await holding.home.setup.save(draft.id, { mode: 'attach', deviceId: device.id, name: device.name });
        const way = saved.connections.find((each) => each.method === stay.method && each.heldBy.id === me);
        if (way && stay.connection) {
          const secrets = Object.fromEntries(own.connections.secretFields(stay.connection).flatMap((field) => {
            const value = own.connections.secret(stay.connection!, field);
            return value === null ? [] : [[field, value] as const];
          }));
          kept.push({ way: way.id, secrets });
        }
      } catch (error) {
        applied.notes.push(`${stay.name}: its ${stay.label} could not stay with this app: ${(error as Error).message}`);
      }
    }
    // Held from now on, its keys here.
    await holding.refresh();
    for (const { way, secrets } of kept) if (Object.keys(secrets).length) await holding.setSecrets(way, secrets);
    own.state.set(MOVED, new Date().toISOString());
    return applied;
  }
}
