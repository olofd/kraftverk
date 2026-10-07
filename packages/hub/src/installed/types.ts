import { checkContribution, type AutomationContribution } from '@kraftverk/automation';
import {
  asJson,
  connectionProblems,
  entryOf,
  isBridgedMethod,
  methodsOf,
  sourceProblem,
  validateDeviceType,
  type DeviceType,
  type FileMigration,
  type FileTypes,
  type IntegrationInfo,
  type TransportDefinition,
  type TypeEntry,
  type TypeSource,
} from '@kraftverk/device-sdk';

import type { Contributed } from '@kraftverk/automation-engine';

import type { ProtocolRegistry, Refused } from './protocols.ts';

/**
 * The integrations installed where the home runs, and the device types they
 * and the device packages on them declare — found rather than listed.
 *
 * An integration teaches a platform and a device package one product on it
 * (docs/PLAN-INTEGRATIONS.md §1): each says so in its package.json's
 * `kraftverk` section, under `packages/integrations` or `packages/devices`.
 * Adding one is adding the package — nothing here names a product, and
 * nothing needs editing. Every type keeps where it came from: the platform it
 * is on, and whether it is a product on it or the platform's own.
 *
 * Two things are kept of a type (docs/PLAN-INTEGRATIONS.md §6.1). Its
 * **entry** — everything it declares as data, from its package's catalogue —
 * for every installed type, from the start: what is listed, offered, found
 * and planned by. Its **code** only once its integration has loaded: when a
 * device of it opens, a sighting its ways are found by needs confirming, or a
 * person starts adding one (`load`). An integration nobody uses is never
 * imported.
 *
 * Every type is checked against the contract when its code loads. One that
 * fails is refused and the reasons kept, so a broken package is a line in the
 * log and on the diagnostics screen rather than a device that half works; and
 * one broken package never stops the others. A method whose protocol or
 * transport is not installed is a warning, not a refusal: the type's other
 * methods still work.
 *
 * What a package brings to automations is its own entry beside its type —
 * `"automation": "./src/automation.ts"` — namespaced by that type, loaded
 * with it and checked the same way: a contribution that breaks the rules is
 * refused, and its type still installed.
 */

/** One integration as held: how its code is loaded, and how that went. */
type Held = { info: IntegrationInfo; load: (() => Promise<void>) | null; loading: Promise<boolean> | null; loaded: boolean };

export class DeviceTypeRegistry {
  #integrations = new Map<string, Held>();
  #migrations: FileMigration[] = [];
  #entries = new Map<string, TypeEntry>();
  #types = new Map<string, DeviceType<any>>();
  #sources = new Map<string, TypeSource>();
  #refused: Refused[] = [];
  #warnings = new Map<string, string[]>();
  #contributed: Contributed[] = [];
  #contributing = new Set<(contributed: Contributed) => void>();

  /** Accepts an integration, before its types — one id is one platform — and how its entries in a file changed. */
  installIntegration(integration: IntegrationInfo, source = integration.id, migrations: readonly FileMigration[] = []): string[] {
    if (this.#integrations.has(integration.id)) {
      const problems = [`another package already is the integration "${integration.id}"`];
      this.refuse(source, problems);
      return problems;
    }
    this.#integrations.set(integration.id, { info: integration, load: null, loading: null, loaded: true });
    this.#migrations.push(...migrations);
    return [];
  }

  /** How an installed integration's code is loaded, when it is first needed: until then, only its types' entries are held. */
  loadsWith(integration: string, load: () => Promise<void>): void {
    const held = this.#integrations.get(integration);
    if (!held) return;
    held.load = load;
    held.loaded = false;
  }

  /** Every installed integration's file migrations, and what is installed for them to find their entries by: what reading a file is given. */
  fileMigrations(): { migrations: readonly FileMigration[]; installed: FileTypes } {
    return { migrations: this.#migrations, installed: this.all().map((type) => ({ id: type.id, methods: methodsOf(type).map((method) => ({ id: method.id, through: [...(method.through ?? [])] })) })) };
  }

  /** The problems with a type's place, before anything of it is kept: its namespace, its integration, its id taken. */
  #placeProblems(id: string, from: TypeSource): string[] {
    const problems: string[] = [];
    const misplaced = id ? sourceProblem(id, from) : null;
    if (misplaced) problems.push(misplaced);
    if (!this.#integrations.has(from.integration.id)) problems.push(`its integration "${from.integration.id}" is not installed`);
    if (!problems.length && this.#entries.has(id)) problems.push(`another package already provides ${id}`);
    return problems;
  }

  /**
   * Accepts one type's entry, from its package's catalogue: listed, offered
   * and found by from now on, its code loaded with its integration's.
   */
  declare(entry: TypeEntry, from: TypeSource, source = entry.id): string[] {
    const problems = this.#placeProblems(entry.id, from);
    if (problems.length) {
      this.refuse(source, problems);
      return problems;
    }
    this.#entries.set(entry.id, entry);
    this.#sources.set(entry.id, from);
    return [];
  }

  /**
   * Accepts one type with its code, if it keeps the contract and comes from
   * an installed integration — as its own, in its namespace, or as a product
   * on it. How a test brings a type of its own, and an app or a test an
   * integration it has already imported.
   */
  install(type: DeviceType<any>, from: TypeSource, source = type.id): string[] {
    const problems = [...validateDeviceType(type), ...this.#placeProblems(type.id, from)];
    if (problems.length) {
      this.refuse(source, problems);
      return problems;
    }
    this.#entries.set(type.id, entryOf(type));
    this.#sources.set(type.id, from);
    this.#types.set(type.id, type);
    return [];
  }

  /**
   * A declared type's code, loaded with its integration: checked against the
   * contract, and against its entry — a catalogue not generated again since
   * the package changed is said, and the code's word taken.
   */
  provide(type: DeviceType<any>, source = type.id): string[] {
    const entry = this.#entries.get(type.id);
    const problems = entry ? validateDeviceType(type) : [`${type.id} is in its integration's code but not in its catalogue: run npm run gen:devices`];
    if (problems.length) {
      this.refuse(source, problems);
      return problems;
    }
    const now = asJson(entryOf(type));
    if (JSON.stringify(now) !== JSON.stringify(entry)) {
      console.warn(`[devices] ${type.id}: its catalogue is not its code's; run npm run gen:devices. Its code is taken.`);
      this.#entries.set(type.id, now);
    }
    this.#types.set(type.id, type);
    return [];
  }

  /** The installed integrations, in the order they were installed. */
  integrations(): IntegrationInfo[] {
    return [...this.#integrations.values()].map((held) => held.info);
  }

  /** The integrations whose code has loaded: an integration nobody uses is not among them. */
  loadedIntegrations(): string[] {
    return [...this.#integrations.values()].filter((held) => held.loaded).map((held) => held.info.id);
  }

  /** Where an installed type came from: its platform, and whether it is a product on it. */
  sourceOf(id: string): TypeSource | null {
    return this.#sources.get(id) ?? null;
  }

  /** Accepts what an installed type's package brings to automations, if it keeps the rules. */
  contribute(type: DeviceType<any>, contribution: AutomationContribution, source = type.id): string[] {
    const problems = checkContribution(contribution, type.id);
    if (problems.length) {
      this.refuse(`${source} (what it brings to automations)`, problems);
      return problems;
    }
    const contributed: Contributed = { contribution, from: { typeId: type.id, name: type.meta.name } };
    this.#contributed.push(contributed);
    for (const listener of this.#contributing) listener(contributed);
    return [];
  }

  /** What the loaded packages bring to automations. */
  contributions(): readonly Contributed[] {
    return this.#contributed;
  }

  /** Told of each contribution as its package loads after this: an automation library grows with what is loaded. */
  onContribution(listener: (contributed: Contributed) => void): () => void {
    this.#contributing.add(listener);
    return () => void this.#contributing.delete(listener);
  }

  /** Checks every type's methods against what is installed, and keeps what does not fit. */
  checkConnections(installed: { protocols: Pick<ProtocolRegistry, 'get' | 'integrationOf'>; transport(id: string): TransportDefinition | null }): void {
    this.#warnings.clear();
    for (const type of this.#entries.values()) {
      // A way through a bridge goes through an installed type that is one.
      const problems = connectionProblems(type, { protocol: (id) => installed.protocols.get(id), transport: installed.transport, type: (id) => this.get(id) });
      // A way speaks its own integration's protocol: a device is reached through its integration, not another's.
      const own = this.#sources.get(type.id)?.integration.id;
      for (const method of type.connections) {
        if (isBridgedMethod(method)) continue;
        const of = installed.protocols.integrationOf(method.protocol);
        if (own && of && of !== own) problems.push(`connection method "${method.id}" speaks "${method.protocol}", which is the ${of} integration's, not ${own}'s`);
      }
      if (!problems.length) continue;
      this.#warnings.set(type.id, problems);
      console.warn(`[devices] ${type.id}:\n  - ${problems.join('\n  - ')}`);
    }
  }

  /** A type's entry: what it declares, as data. Every installed type has one, loaded or not. */
  get(id: string): TypeEntry | null {
    return this.#entries.get(id) ?? null;
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /** Every installed type's entry. */
  all(): TypeEntry[] {
    return [...this.#entries.values()];
  }

  /** A type's code, if its integration has loaded; null until then. What runs after a `load` reads. */
  loaded(id: string): DeviceType<any> | null {
    return this.#types.get(id) ?? null;
  }

  /** A type's code, its integration loaded first if it has not: null when nothing installed is that type, or its code would not load. */
  async load(id: string): Promise<DeviceType<any> | null> {
    const source = this.#sources.get(id);
    if (!source) return null;
    await this.loadIntegration(source.integration.id);
    return this.#types.get(id) ?? null;
  }

  /** Loads an integration's code, once — every caller waits on the same import. Whether it loaded. */
  loadIntegration(id: string): Promise<boolean> {
    const held = this.#integrations.get(id);
    if (!held) return Promise.resolve(false);
    if (held.loaded || !held.load) return Promise.resolve(true);
    held.loading ??= held.load().then(
      () => {
        held.loaded = true;
        return true;
      },
      (error: unknown) => {
        this.refuse(held.info.id, [`its code would not load: ${(error as Error).message}`]);
        // Asked again, it is tried again: a file being written as it was read loads the next time.
        held.loading = null;
        return false;
      }
    );
    return held.loading;
  }

  /** Packages that were found and turned away, and why. */
  get refused(): readonly Refused[] {
    return this.#refused;
  }

  /** Methods of installed types that name something not installed. */
  warnings(id: string): readonly string[] {
    return this.#warnings.get(id) ?? [];
  }

  /** Keeps a package that was found and turned away, and why: one that would not load, say. */
  refuse(source: string, problems: string[]): void {
    this.#refused.push({ source, problems });
    console.warn(`[devices] ${source} is refused:\n  - ${problems.join('\n  - ')}`);
  }
}
