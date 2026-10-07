import type { FoundView } from '@kraftverk/api-contract';
import { BRIDGE_TRANSPORT, isBridgedMethod, sightingMatches, type DirectMethod, type Matcher, type Sighting, type TypeEntry } from '@kraftverk/device-sdk';
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
 * (docs/DATA-MODEL.md §1, step 1; docs/PLAN-INTEGRATIONS.md §4.4).
 *
 * Found by declaration: every way says what it is found by (its
 * `discovery` matchers, from its package's catalogue), and a sighting is
 * matched against those as data — no integration's code is even loaded
 * until a way's matchers pick a sighting out; then it is, and its
 * protocol's `recognise` confirms and reads it, offered from the next look. Each
 * sighting is one host, gathered by its transport, so a device that
 * announces itself five ways is offered once.
 *
 * Live state, never stored — but for what a person said not to offer again,
 * which is listed apart, marked, where it can be brought back. A transport
 * that costs nothing to watch (`background`: broadcasts, a broker's clients)
 * is watched from the start, so what turns up is offered without anyone
 * asking; one that must scan a radio is watched when someone asks, and
 * stops a minute after they stop.
 */

const IDLE_MS = 60_000;

type Watching = { stop: () => void; sightings: readonly Sighting[]; background: boolean };

/** A way that is found, with its type. */
type Findable = { type: TypeEntry; method: DirectMethod & { discovery: readonly Matcher[] } };

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

  /** Watches every transport that costs nothing to watch, from now until `stop`. */
  start(): void {
    for (const definition of this.deps.transports.definitions()) if (definition.background) this.#watch(definition.id, true);
  }

  /** What can be seen now. The first call starts watching what is watched on demand, so it may be empty. */
  list(): FoundView[] {
    this.#keepWatching();
    const found: FoundView[] = [];
    for (const [transportId, { sightings }] of this.#watching) {
      const ways = this.#findable(transportId);
      for (const sighting of sightings) {
        if (this.deps.connections.claimant(transportId, sighting.address)) continue;
        const picked = ways.filter(({ method }) => sightingMatches(method.discovery, sighting));
        for (const protocolId of new Set(picked.map(({ method }) => method.protocol))) {
          // Its protocol confirms what the matchers picked: its integration's code is loaded for that, and asked when it has.
          const protocol = this.deps.protocols.loaded(protocolId);
          if (!protocol) {
            void this.deps.protocols.load(protocolId);
            continue;
          }
          const recognised = protocol.bindings[transportId]?.recognise(sighting);
          if (!recognised) continue;
          // Yours already, at another address — a plug the router gave a new one: not something new.
          if (recognised.identity && this.deps.catalog.byIdentity(recognised.identity).active) continue;
          found.push({
            transport: transportId,
            protocol: protocolId,
            address: sighting.address,
            through: null,
            ignored: this.deps.ignored.has({ transport: transportId, through: null, address: sighting.address }),
            name: recognised.name,
            detail: recognised.detail ?? null,
            identity: recognised.identity ?? null,
            model: recognised.model ?? null,
            about: null,
            joining: false,
            seenAt: sighting.seenAt,
            types: picked
              .filter(({ method }) => method.protocol === protocolId)
              .map(({ type, method }) => ({ typeId: type.id, methodId: method.id, name: type.meta.name, category: type.meta.category })),
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
          about: member.about,
          joining: member.joining,
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

  /** Every way over this transport that says what it is found by. */
  #findable(transportId: string): Findable[] {
    return this.deps.types.all().flatMap((type) =>
      type.connections.flatMap((method) => (!isBridgedMethod(method) && method.transport === transportId && method.discovery?.length ? [{ type, method: method as Findable['method'] }] : []))
    );
  }

  /** Watches one transport for what its ways are found by, if it lists here and any way is found on it. */
  #watch(transportId: string, background: boolean): void {
    if (this.#watching.has(transportId) || this.deps.transports.definition(transportId)?.discovery[this.deps.transports.platform] !== 'list') return;
    const transport = this.deps.transports.get(transportId);
    const matchers = this.#findable(transportId).flatMap(({ method }) => method.discovery);
    if (!transport?.watch || !matchers.length) return;
    const watching: Watching = { stop: () => {}, sightings: [], background };
    watching.stop = transport.watch(matchers, (sightings) => {
      watching.sightings = sightings;
    });
    this.#watching.set(transportId, watching);
  }

  /** Watches what is watched on demand, until a minute after the last ask. */
  #keepWatching(): void {
    for (const definition of this.deps.transports.definitions()) this.#watch(definition.id, definition.background);
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.#rest(), IDLE_MS);
    unref(this.#idle);
  }

  /** Stops watching what is watched on demand; what costs nothing goes on. */
  #rest(): void {
    this.#idle = null;
    for (const [transportId, watching] of this.#watching) {
      if (watching.background) continue;
      watching.stop();
      this.#watching.delete(transportId);
    }
  }
}
