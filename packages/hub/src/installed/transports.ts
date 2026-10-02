import { capitalise } from '@kraftverk/automation';
import {
  memoryTransportStore,
  validateTransportDefinition,
  type Availability,
  type Platform,
  type Transport,
  type TransportContext,
  type TransportDefinition,
  type TransportFactory,
  type TransportStore,
} from '@kraftverk/device-sdk';

import type { Refused } from './protocols.ts';

/**
 * The transports a home can reach devices over where it runs — the server, a
 * browser, a phone — installed by whoever found them, and started only when
 * wanted.
 *
 * There is one of each per home — one radio, one connection to the broker —
 * shared by every connection over it. Every installed transport is available:
 * none is switched on or off by configuration. One that cannot run here —
 * Bluetooth in a container with no radio, the broker in a browser — says so,
 * and that reason is what a connection over it shows.
 */

type Entry = {
  definition: TransportDefinition;
  factory: (() => Promise<TransportFactory>) | null;
  transport: Transport | null;
  starting: Promise<Transport | null> | null;
  error: string | null;
};

export type TransportHostOptions = {
  /** Where it runs: which of a transport's entries is this place's. */
  platform: Platform;
  /** What every transport is handed: the environment, the log, the timeline. */
  context: Omit<TransportContext, 'store'>;
  /** Each transport's own store, by its id: the database's `transport_kv`. In memory when absent. */
  store?: (transport: string) => TransportStore;
};

export class TransportHost {
  #entries = new Map<string, Entry>();
  #refused: Refused[] = [];

  constructor(private options: TransportHostOptions) {}

  /** Where it runs: which of a transport's entries is this place's. */
  get platform(): Platform {
    return this.options.platform;
  }

  /** What one transport is handed: the shared context, and its own store. */
  #contextFor(id: string): TransportContext {
    return { ...this.options.context, store: this.options.store?.(id) ?? memoryTransportStore() };
  }

  /**
   * Accepts one transport: its definition, and how to make it here — a
   * module to load, or (in a test, or from the app's registry) a factory to
   * call. Null when it has no implementation for this platform, as the broker
   * has none in a browser.
   */
  install(
    definition: TransportDefinition,
    here: { load: () => Promise<TransportFactory> } | { create: TransportFactory } | null,
    source = definition.id
  ): string[] {
    const problems = validateTransportDefinition(definition);
    if (!problems.length && this.#entries.has(definition.id)) problems.push(`another package already provides ${definition.id}`);
    if (problems.length) {
      this.refuse(source, problems);
      return problems;
    }
    this.#entries.set(definition.id, {
      definition,
      factory: here === null ? null : 'load' in here ? here.load : async () => here.create,
      transport: null,
      starting: null,
      error: null,
    });
    return [];
  }

  definition(id: string): TransportDefinition | null {
    return this.#entries.get(id)?.definition ?? null;
  }

  definitions(): TransportDefinition[] {
    return [...this.#entries.values()].map((entry) => entry.definition);
  }

  /** The transports with an entry where this runs, by id: what this node can reach devices over. */
  here(): string[] {
    return this.definitions()
      .filter((definition) => definition.platforms.includes(this.platform))
      .map((definition) => definition.id);
  }

  get refused(): readonly Refused[] {
    return this.#refused;
  }

  /** The transport, if it has started. */
  get(id: string): Transport | null {
    return this.#entries.get(id)?.transport ?? null;
  }

  /**
   * Whether a connection over this transport can be held here now, and if
   * not, why — in words a person can act on.
   */
  available(id: string): Availability {
    const entry = this.#entries.get(id);
    const place = platformWords(this.options.platform);
    if (!entry) return { ok: false, reason: `${place.this} cannot reach devices this way: it needs updating` };
    if (!entry.definition.platforms.includes(this.options.platform) || !entry.factory) {
      return { ok: false, reason: `${place.a} cannot use ${entry.definition.label}` };
    }
    if (entry.error) return { ok: false, reason: entry.error };
    if (!entry.transport) return { ok: false, reason: `${capitalise(entry.definition.label)} is starting` };
    return entry.transport.available();
  }

  /** Starts a transport, once. Null when it cannot run here; never throws. */
  async start(id: string): Promise<Transport | null> {
    const entry = this.#entries.get(id);
    if (!entry?.factory || !entry.definition.platforms.includes(this.options.platform)) return null;
    if (entry.transport) return entry.transport;
    entry.starting ??= (async () => {
      try {
        const factory = await entry.factory!();
        const transport = factory(this.#contextFor(id));
        await transport.start();
        entry.transport = transport;
        entry.error = null;
        return transport;
      } catch (error) {
        // Recorded, not thrown: one transport that cannot start must not keep
        // the home — or the devices on every other transport — down.
        entry.error = (error as Error).message;
        this.options.context.log('warn', `[transports] ${id} could not start: ${entry.error}`);
        return null;
      } finally {
        entry.starting = null;
      }
    })();
    return entry.starting;
  }

  /** Starts each of these, together, reporting rather than throwing. */
  async startAll(ids: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(ids)].map((id) => this.start(id)));
  }

  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.#entries.values()].map(async (entry) => {
        const transport = entry.transport;
        entry.transport = null;
        await transport?.stop().catch(() => undefined);
      })
    );
  }

  /** Keeps a package that was found and turned away, and why: one that would not load, say. */
  refuse(source: string, problems: string[]): void {
    this.#refused.push({ source, problems });
    console.warn(`[transports] ${source} is not a usable transport:\n  - ${problems.join('\n  - ')}`);
  }
}

/** What a node is called by where it runs, in a reason a person reads: "This node cannot…", "A browser cannot…". */
export const platformWords = (platform: Platform): { this: string; a: string } => PLACES[platform];

const PLACES: Record<Platform, { this: string; a: string }> = {
  system: { this: 'This node', a: 'A node on a machine' },
  web: { this: 'This browser', a: 'A browser' },
  native: { this: 'This phone', a: 'A phone' },
};
