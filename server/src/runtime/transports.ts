import {
  validateTransportDefinition,
  type Availability,
  type Transport,
  type TransportContext,
  type TransportDefinition,
  type TransportFactory,
} from '@kraftverk/device-sdk';

import { findPackages, load, ROOTS } from './packages.ts';
import type { Refused } from './protocols.ts';

/**
 * The transports this server can reach devices over, found rather than listed,
 * and started only when wanted.
 *
 * There is one of each per process — one radio, one connection to the broker —
 * shared by every connection over it. Every installed transport is available:
 * none is switched on or off by configuration. One that cannot run where the
 * server runs — Bluetooth in a container with no radio — says so, and that
 * reason is what a connection over it shows.
 */

type Entry = {
  definition: TransportDefinition;
  factory: (() => Promise<TransportFactory>) | null;
  transport: Transport | null;
  starting: Promise<Transport | null> | null;
  error: string | null;
};

export type TransportHostOptions = {
  context: TransportContext;
};

export class TransportHost {
  #entries = new Map<string, Entry>();
  #refused: Refused[] = [];

  constructor(private options: TransportHostOptions) {}

  async discover(roots: readonly string[] = ROOTS.transports): Promise<void> {
    const { found, problems } = await findPackages(roots, 'transport');
    this.#refused.push(...problems);
    for (const pkg of found) {
      const entries = pkg.kraftverk.transport as { definition?: string; server?: string } | undefined;
      try {
        if (!entries?.definition) throw new Error('its transport entry names no definition');
        const definition = await load<TransportDefinition>(pkg, entries.definition);
        this.install(definition, entries.server ? { load: () => load<TransportFactory>(pkg, entries.server!) } : null, pkg.name);
      } catch (error) {
        this.#refuse(pkg.folder, [(error as Error).message]);
      }
    }
  }

  /**
   * Accepts one transport: its definition, and how to make it on the server —
   * a module to load, or (in a test) a factory to call. Null when it has no
   * server implementation, like a browser-only one.
   */
  install(
    definition: TransportDefinition,
    server: { load: () => Promise<TransportFactory> } | { create: TransportFactory } | null,
    source = definition.id
  ): string[] {
    const problems = validateTransportDefinition(definition);
    if (!problems.length && this.#entries.has(definition.id)) problems.push(`another package already provides ${definition.id}`);
    if (problems.length) {
      this.#refuse(source, problems);
      return problems;
    }
    this.#entries.set(definition.id, {
      definition,
      factory: server === null ? null : 'load' in server ? server.load : async () => server.create,
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

  get refused(): readonly Refused[] {
    return this.#refused;
  }

  /** The transport, if it has started. */
  get(id: string): Transport | null {
    return this.#entries.get(id)?.transport ?? null;
  }

  /**
   * Whether a connection over this transport can be held by this server now,
   * and if not, why — in words a person can act on.
   */
  available(id: string): Availability {
    const entry = this.#entries.get(id);
    if (!entry) return { ok: false, reason: 'This server cannot reach devices this way: it needs updating' };
    if (!entry.definition.platforms.includes('server') || !entry.factory) {
      return { ok: false, reason: `A server cannot use ${entry.definition.label}` };
    }
    if (entry.error) return { ok: false, reason: entry.error };
    if (!entry.transport) return { ok: false, reason: `${capitalise(entry.definition.label)} is starting` };
    return entry.transport.available();
  }

  /** Starts a transport, once. Null when it cannot run here; never throws. */
  async start(id: string): Promise<Transport | null> {
    const entry = this.#entries.get(id);
    if (!entry?.factory || !entry.definition.platforms.includes('server')) return null;
    if (entry.transport) return entry.transport;
    entry.starting ??= (async () => {
      try {
        const factory = await entry.factory!();
        const transport = factory(this.options.context);
        await transport.start();
        entry.transport = transport;
        entry.error = null;
        return transport;
      } catch (error) {
        // Recorded, not thrown: one transport that cannot start must not keep
        // the server — or the devices on every other transport — down.
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

  #refuse(source: string, problems: string[]): void {
    this.#refused.push({ source, problems });
    console.warn(`[transports] ${source} is not a usable transport:\n  - ${problems.join('\n  - ')}`);
  }
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
