import type { FoundView } from '@kraftverk/api-contract';
import type { Sighting, SightingFilter } from '@kraftverk/device-sdk';

import type { ProtocolRegistry } from '../runtime/protocols.ts';
import type { TransportHost } from '../runtime/transports.ts';
import type { ConnectionStore } from '@kraftverk/store';
import type { DeviceTypeRegistry } from './types.ts';

/**
 * "Found near you": what this server's transports can see that no device you
 * have is reached by (docs/DATA-MODEL.md §1, step 1).
 *
 * Live state, never stored. Watching starts when someone asks and stops a
 * minute after they stop asking, so an idle server is not scanning the radio
 * for nobody.
 */

const IDLE_MS = 60_000;

type Watching = { stop: () => void; sightings: readonly Sighting[] };

export class Nearby {
  #watching = new Map<string, Watching>();
  #idle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private deps: { types: DeviceTypeRegistry; protocols: ProtocolRegistry; transports: TransportHost; connections: ConnectionStore }
  ) {}

  /** What can be seen now. The first call starts watching, so it may be empty. */
  list(): FoundView[] {
    this.#keepWatching();
    const found: FoundView[] = [];
    for (const [transportId, { sightings }] of this.#watching) {
      for (const sighting of sightings) {
        if (this.deps.connections.claimant(transportId, sighting.address)) continue;
        for (const protocol of this.deps.protocols.all()) {
          const recognised = protocol.bindings[transportId]?.recognise(sighting);
          if (!recognised) continue;
          const types = this.deps.types.all().flatMap((type) =>
            type.connections
              .filter((method) => method.protocol === protocol.id && method.transport === transportId)
              .map((method) => ({ typeId: type.id, methodId: method.id, name: type.meta.name, category: type.meta.category }))
          );
          if (!types.length) continue;
          found.push({
            transport: transportId,
            protocol: protocol.id,
            address: sighting.address,
            name: recognised.name,
            detail: recognised.detail ?? null,
            identity: recognised.identity ?? null,
            model: recognised.model ?? null,
            seenAt: sighting.seenAt,
            types,
          });
        }
      }
    }
    return found;
  }

  stop(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    for (const watching of this.#watching.values()) watching.stop();
    this.#watching.clear();
  }

  #keepWatching(): void {
    for (const definition of this.deps.transports.definitions()) {
      if (this.#watching.has(definition.id) || definition.discovery.server !== 'list') continue;
      const transport = this.deps.transports.get(definition.id);
      if (!transport?.watch) continue;
      const watching: Watching = { stop: () => {}, sightings: [] };
      watching.stop = transport.watch(this.#filterFor(definition.id), (sightings) => {
        watching.sightings = sightings;
      });
      this.#watching.set(definition.id, watching);
    }
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.stop(), IDLE_MS);
    this.#idle.unref?.();
  }

  /** Everything any installed protocol looks for on this transport. */
  #filterFor(transportId: string): SightingFilter {
    const filters = this.deps.protocols.all().flatMap((protocol) => protocol.bindings[transportId]?.filter ?? []);
    const merge = <K extends keyof SightingFilter>(key: K) => [...new Set(filters.flatMap((filter) => (filter[key] ?? []) as never[]))];
    return { services: merge('services'), namePrefixes: merge('namePrefixes'), udpPorts: merge('udpPorts') };
  }
}
