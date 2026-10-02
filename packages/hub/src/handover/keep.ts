import { ApiError, type ElsewhereView, type ImportAnswers, type ImportApplied, type ImportPlan } from '@kraftverk/api-contract';
import { readConfig } from '@kraftverk/home-file';
import { AppState, ConnectionStore, DeviceCatalog, LastHeard, type SecretsAtRest, type SqlDatabase } from '@kraftverk/store';

import type { Hub } from '../hub.ts';
import { nothingToDo } from './nothing.ts';

/*
  A server's home, kept by this app (docs/PLAN-SHARED-CORE.md, phase 6h):
  the app stopped using its server — let go of it, or lost it — and the
  copy it kept of the server's home becomes its own. What the server's
  configuration said, as this app last heard it, is restored into the app's
  own home as a restore is: what it cannot carry — a secret only the server
  had — is left out and said, and a way only a server can hold comes too,
  waiting for one. The ways this app held for the server come with their
  secrets, which never left it. Its history is the server's, and stays there.
*/

/** Kept in the copy, once it has been brought in: not offered again. */
const KEPT = 'home.kept';

export class KeepingCopy {
  readonly #hub: Hub;
  readonly #state: AppState;
  readonly #heard: LastHeard;
  readonly #catalog: DeviceCatalog;
  readonly #connections: ConnectionStore;
  /** The plans made from the copy, by id: what their apply brings beside the file. */
  readonly #plans = new Set<string>();

  /** `copy`: the database this app kept for the server it used last; `secrets`: this app's key, which sealed its ways' secrets there. */
  constructor(hub: Hub, copy: SqlDatabase, secrets: SecretsAtRest) {
    this.#hub = hub;
    this.#state = new AppState(copy);
    this.#heard = new LastHeard(copy);
    this.#catalog = new DeviceCatalog(copy);
    this.#connections = new ConnectionStore(copy, secrets);
  }

  /** The server's configuration, as this app last heard it; null when it never heard one, or it has been brought in. */
  #text(): string | null {
    if (this.#state.get(KEPT)) return null;
    return this.#heard.get<string>('configuration')?.body ?? null;
  }

  /** What bringing the copy in would bring; null when there is nothing to. */
  what(): ElsewhereView {
    const text = this.#text();
    const document = text ? readConfig(text, {}, undefined, { partial: true }).document : null;
    const devices = Object.keys(document?.devices ?? {}).length;
    const automations = Object.keys(document?.automations ?? {}).length;
    return devices || automations ? { from: 'copy', devices, automations } : null;
  }

  owns(plan: string): boolean {
    return this.#plans.has(plan);
  }

  /** What keeping the copy would do here: planned as a restore is, and what comes beside the file said. */
  async plan(mode: 'merge' | 'replace', by: string): Promise<ImportPlan> {
    const text = this.#text();
    if (!text) throw new ApiError('not-found', 'This app keeps no copy of a server’s home to bring in');
    const plan = await this.#hub.configuration.plan(text, { mode, lenient: true }, by);
    if (plan.id) this.#plans.add(plan.id);
    // All of it is here already, as the server had it: there is nothing to bring, and it is not offered again.
    const held = this.#catalog.list().some((kept) => this.#connections.forDevice(kept.id).length > 0);
    if (nothingToDo(plan) && !held) this.#state.set(KEPT, new Date().toISOString());
    const ways = this.#catalog.list().flatMap((device) => this.#connections.forDevice(device.id).map(() => device.name));
    return {
      ...plan,
      notes: [
        ...plan.notes,
        'As your server last said it: its history stays with the server.',
        ...ways.map((name) => `${name}: the way this app held for the server comes with it, and its key`),
      ],
    };
  }

  /** Brings it in, and the ways this app held with their secrets; what could not come is said. */
  async apply(answers: ImportAnswers, by: string): Promise<ImportApplied> {
    const applied = await this.#hub.configuration.apply(answers, by);
    this.#plans.delete(answers.plan);
    const { catalog, connections } = this.#hub;
    for (const kept of this.#catalog.list()) {
      const device = catalog.byKey(kept.key);
      if (!device) continue;
      for (const way of this.#connections.forDevice(kept.id)) {
        if (connections.forDevice(device.id).some((had) => had.method === way.method && had.heldBy === this.#hub.self.id)) continue;
        try {
          const added = connections.add({ deviceId: device.id, method: way.method, transport: way.transport, heldBy: this.#hub.self.id, address: way.address, config: way.config });
          const secrets = Object.fromEntries(this.#connections.secretFields(way.id).flatMap((field) => {
            const value = this.#connections.secret(way.id, field);
            return value === null ? [] : [[field, value] as const];
          }));
          if (Object.keys(secrets).length) connections.setSecrets(added.id, secrets);
        } catch (error) {
          applied.notes.push(`${device.name}: the way this app held could not come with it: ${(error as Error).message}`);
        }
      }
    }
    await this.#hub.sessions.sync(catalog.list());
    this.#hub.bus.publish({ kind: 'changed', deviceId: null });
    this.#state.set(KEPT, new Date().toISOString());
    return applied;
  }
}
