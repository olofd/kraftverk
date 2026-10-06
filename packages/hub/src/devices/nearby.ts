import type { FoundView } from '@kraftverk/api-contract';
import { BRIDGE_TRANSPORT, type Sighting, type SightingFilter } from '@kraftverk/device-sdk';
import type { SessionManager } from '@kraftverk/holder';
import type { ConnectionStore, DeviceCatalog, IgnoredSightings } from '@kraftverk/store';

import type { ProtocolRegistry } from '../installed/protocols.ts';
import type { TransportHost } from '../installed/transports.ts';
import type { DeviceTypeRegistry } from '../installed/types.ts';
import { unref } from '../timers.ts';
import { membersOnOffer } from './members.ts';

/**
 * "Found near you": what this home's transports can see, and the bridges open
 * here have behind them, that no device you have is reached by
 * (docs/DATA-MODEL.md §1, step 1; docs/PLAN-INTEGRATIONS.md §4.3).
 *
 * Live state, never stored — but for what a person said not to offer again,
 * which is listed apart, marked, where it can be brought back. Watching
 * starts when someone asks and stops a minute after they stop asking, so an
 * idle home is not scanning the radio for nobody.
 */

const IDLE_MS = 60_000;

type Watching = { stop: () => void; sightings: readonly Sighting[] };

export class Nearby {
  #watching = new Map<string, Watching>();
  #idle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private deps: {
      types: DeviceTypeRegistry;
      protocols: ProtocolRegistry;
      transports: TransportHost;
      connections: ConnectionStore;
      catalog: DeviceCatalog;
      sessions: SessionManager;
      ignored: IgnoredSightings;
    }
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
            through: null,
            ignored: this.deps.ignored.has({ transport: transportId, through: null, address: sighting.address }),
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
    return [...found, ...this.#members()];
  }

  /** The members of the bridges open here that nothing you have is, and that an installed type knows. */
  #members(): FoundView[] {
    const now = new Date().toISOString();
    return membersOnOffer(this.deps).flatMap(({ bridge, member, claimedBy, types }) => {
      if (claimedBy || !types.length) return [];
      return [
        {
          transport: BRIDGE_TRANSPORT,
          protocol: null,
          address: member.key,
          through: { id: bridge.id, name: bridge.name },
          ignored: this.deps.ignored.has({ transport: BRIDGE_TRANSPORT, through: bridge.id, address: member.key }),
          name: member.name ?? member.key,
          detail: `Through ${bridge.name}`,
          identity: member.identity,
          model: member.model,
          seenAt: now,
          types: types.map(({ type, methodId }) => ({ typeId: type.id, methodId, name: type.meta.name, category: type.meta.category })),
        },
      ];
    });
  }

  stop(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = null;
    for (const watching of this.#watching.values()) watching.stop();
    this.#watching.clear();
  }

  #keepWatching(): void {
    for (const definition of this.deps.transports.definitions()) {
      if (this.#watching.has(definition.id) || definition.discovery[this.deps.transports.platform] !== 'list') continue;
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
    unref(this.#idle);
  }

  /** Everything any installed protocol looks for on this transport. */
  #filterFor(transportId: string): SightingFilter {
    const filters = this.deps.protocols.all().flatMap((protocol) => protocol.bindings[transportId]?.filter ?? []);
    const merge = <K extends keyof SightingFilter>(key: K) => [...new Set(filters.flatMap((filter) => (filter[key] ?? []) as never[]))];
    return { services: merge('services'), namePrefixes: merge('namePrefixes'), udpPorts: merge('udpPorts') };
  }
}
