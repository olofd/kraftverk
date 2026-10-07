import { BRIDGE_TRANSPORT, type MemberLink } from './bridge.ts';
import type { Channel, ChannelKind } from './channel.ts';
import type { DeviceDescription, DeviceInfo } from './description.ts';
import { PLATFORMS, type NodeNeeds, type Platform } from './node.ts';
import type { Protocol } from './protocol.ts';
import type { ConfigSchema, ConfigValues } from './schema.ts';
import type { SetupStep } from './setup.ts';
import type { Availability, Matcher, Transport, TransportDefinition } from './transport.ts';

/**
 * How a device is reached: transports, protocols, and the connection methods a
 * device type declares by pairing them (docs/ARCHITECTURE.md §4, and
 * docs/DATA-MODEL.md §2).
 *
 * Three layers, each talking only to the one next to it:
 *
 * - A **transport** moves bytes or messages and finds devices. It owns every
 *   socket and radio, and knows nothing about what it carries. It ships one
 *   implementation for each place it can run.
 * - A **protocol** is the language spoken over a transport: framing,
 *   encryption, message shapes. Pure code — it speaks over the channel it is
 *   given and never opens one — with a *binding* for each transport it rides.
 * - A **device type** knows what the values mean, and speaks its protocol over
 *   an open connection it is handed.
 *
 * The contract between a transport and a protocol is the *channel*: a transport
 * opens one of three shapes, and a protocol's binding knows how to speak over
 * it. That is the whole seam, which is why a protocol can run in the server and
 * in the app alike, and why a new transport needs no change to any protocol that
 * already fits its channel.
 */

/**
 * What a way of reaching a device needs besides your home network (H11):
 *
 * - `local` — nothing. It works with the internet unplugged.
 * - `cloud-at-setup` — the vendor's cloud once, while adding it: a key fetched,
 *   an account linked. After that, local.
 * - `cloud` — the internet, always: a web API, a vendor's servers.
 */
export type Reach = 'local' | 'cloud-at-setup' | 'cloud';

export const REACHES: readonly Reach[] = ['local', 'cloud-at-setup', 'cloud'];

/**
 * How what a device says reaches kraftverk, over a way: said as an outcome
 * on the add screen, beside how far it reaches.
 *
 * - `push` — the device says it as it happens.
 * - `poll` — it is asked, every so often: as current as the last time.
 * - `both` — asked, and it says what changes between.
 */
export type Updates = 'push' | 'poll' | 'both';

export const UPDATES: readonly Updates[] = ['push', 'poll', 'both'];

/** What every way of reaching a device says, however it reaches it. */
type WayBase = {
  /** `wifi`, `bluetooth`, `lan`, `account`. Stable forever within the type: connections name it. */
  id: string;
  /** How people say it: "Wi-Fi", "Bluetooth", "Through your account". The holder is added on screen. */
  label: string;
  /** One line on what this way needs or gives. */
  description?: string;
  /** Whether it needs anything beyond your home network: said on the add screen before anything is chosen. */
  reach: Reach;
  /** How what it says arrives: told as it happens, asked for, or both. */
  updates: Updates;
  /** The one to suggest, when a type has several. */
  recommended?: boolean;
  /** Choices of this method's own, stored with the connection. Never secrets. */
  config?: ConfigSchema;
  /**
   * What the node holding it must be, each with why: `{ trusted: 'your account
   * password stays at home' }`. A node that is not is not offered it, and
   * the master refuses to save one such a node would hold — a vendor
   * account's password does not belong in a browser.
   */
  needs?: NodeNeeds;
  /** Steps of the type's own for this method, after those its layers supply. */
  steps?: readonly SetupStep[];
};

/**
 * A way over a transport: its integration's protocol over one transport.
 *
 * Declared as a pair, not as two lists, because not every protocol rides every
 * transport. Where it runs is never said here: a method is offered wherever its
 * transport is available (docs/ARCHITECTURE.md, decision 8).
 */
export type DirectMethod = WayBase & {
  protocol: string;
  transport: string;
  /**
   * A fixed address — a web API's origin — so nothing is chosen. Absent for a
   * device, which is found.
   */
  address?: string;
  /**
   * What it is found by on its transport (docs/PLAN-INTEGRATIONS.md §4.4):
   * the announcements a device reached this way makes — a broadcast on
   * UDP 6667, an mDNS service, a Bluetooth service. Matched as data, without
   * running the integration; its protocol's `recognise` confirms. A device
   * found by one and not yet yours is offered without anyone asking. Absent:
   * it is not found, its address is typed or fixed.
   */
  discovery?: readonly Matcher[];
  /**
   * Where it can be held at all, when that is fewer places than its
   * transport runs: a cloud that does not answer a browser's page is reached
   * over HTTPS from a server and a phone, never from a browser. A fact about
   * software, kept apart from what it `needs` of the node holding it — a
   * choice, with its reason (docs/PLAN-INTEGRATIONS.md §0). Absent: wherever
   * its transport runs.
   */
  platforms?: readonly Platform[];
  through?: never;
};

/**
 * A way through a bridge (docs/PLAN-INTEGRATIONS.md §4.3): a scooter through
 * its account, a plug through its gateway. No protocol and no transport of
 * its own — it reads its bridge through the link the bridge's session hands
 * it — and no credentials: it is signed in as its bridge is. Its address is
 * the member's key within the bridge; it is held wherever the bridge is.
 */
export type BridgedMethod = WayBase & {
  /** The bridge types it is reached through: `['acme.account']`. At least one. */
  through: readonly string[];
  protocol?: never;
  transport?: never;
  address?: never;
  platforms?: never;
  discovery?: never;
};

/** One way a device type can be reached: over a transport, or through a bridge. */
export type ConnectionMethod = DirectMethod | BridgedMethod;

/** Whether a way goes through a bridge rather than over a transport. */
export const isBridgedMethod = (method: ConnectionMethod): method is BridgedMethod => method.through !== undefined;

/** The transport a way's connections are kept under: its own, or the bridge's for a way through one. */
export const transportOf = (method: ConnectionMethod): string => (isBridgedMethod(method) ? BRIDGE_TRANSPORT : method.transport);

/**
 * Simulated: a way every device type can be added, with no hardware.
 *
 * Every type ships a simulator (the contract requires one), so every type can
 * be tried, shown and developed against without the device. Simulation is a
 * choice per device, not a mode of the server: a simulated lamp beside a real
 * station is an ordinary thing to have. A simulated connection names no real
 * protocol or transport; whoever holds it opens its type's simulator in its
 * place, and nothing it does reaches hardware.
 */
export const SIMULATED_METHOD_ID = 'simulated';

export const SIMULATED_TRANSPORT = 'sim';

export const SIMULATED_ADDRESS = 'simulated';

export const SIMULATED_METHOD: DirectMethod = {
  id: SIMULATED_METHOD_ID,
  label: 'Simulated',
  description: 'No hardware: its simulator stands in, to try it out.',
  protocol: SIMULATED_TRANSPORT,
  transport: SIMULATED_TRANSPORT,
  address: SIMULATED_ADDRESS,
  reach: 'local',
  updates: 'push',
};

/** A type's simulated way: chosen with what its own simulator is set up with, when it is set up with anything. */
export const simulatedMethodOf = (type: { readonly simulation?: ConfigSchema }): DirectMethod =>
  type.simulation && Object.keys(type.simulation.fields).length ? { ...SIMULATED_METHOD, config: type.simulation } : SIMULATED_METHOD;

type HasWays = { readonly connections: readonly ConnectionMethod[]; readonly simulation?: ConfigSchema };

/** Every way a type can be added: its own, then simulated. */
export const methodsOf = (type: HasWays): ConnectionMethod[] => [...type.connections, simulatedMethodOf(type)];

/** One of a type's ways, by id, simulated included. */
export const methodOf = (type: HasWays, id: string): ConnectionMethod | null => methodsOf(type).find((method) => method.id === id) ?? null;

/** Whether a connection is simulated: its holder opens the type's simulator, and reaches nothing. */
export const isSimulated = (connection: { readonly transport?: string }): boolean => connection.transport === SIMULATED_TRANSPORT;

/**
 * The runtimes a method can be held on at all: those its transport has an
 * entry for. A simulated one reaches nothing, and is held anywhere.
 */
export function platformsOf(method: ConnectionMethod, transport: Pick<TransportDefinition, 'platforms'> | null): Platform[] {
  // A simulator reaches nothing; a bridge's member is held wherever its bridge is.
  if (isBridgedMethod(method) || isSimulated(method)) return [...PLATFORMS];
  // Its transport's, less what the way itself cannot be held on.
  return (transport?.platforms ?? []).filter((platform) => !method.platforms || method.platforms.includes(platform));
}

/**
 * Where one way of reaching a device can be held — two facts, kept apart
 * (docs/PLAN-INTEGRATIONS.md §0): the platforms its transport runs on, a fact
 * of software; and what the node holding it must be, a choice with its reason.
 */
export type Placement = { method: string; platforms: Platform[]; needs: NodeNeeds };

/**
 * Each of a type's real ways, and where it can be held: what "where it runs"
 * is worked out from. Its simulator runs anywhere, and is not among them. A
 * way through a bridge is held wherever its bridge can be, and needs what
 * its bridge's ways need: worked out from the bridge types, when known.
 */
export function placementsOf(
  type: Pick<HasWays, 'connections'>,
  definitionOf: (id: string) => Pick<TransportDefinition, 'platforms'> | null,
  typeOf: (id: string) => Pick<HasWays, 'connections'> | null = () => null,
  depth = 0
): Placement[] {
  return type.connections.map((method) => {
    if (!isBridgedMethod(method) || depth >= 4) return { method: method.id, platforms: platformsOf(method, method.transport ? definitionOf(method.transport) : null), needs: { ...method.needs } };
    const bridges = method.through.flatMap((id) => {
      const bridge = typeOf(id);
      return bridge ? placementsOf(bridge, definitionOf, typeOf, depth + 1) : [];
    });
    if (!bridges.length) return { method: method.id, platforms: platformsOf(method, null), needs: { ...method.needs } };
    return {
      method: method.id,
      platforms: PLATFORMS.filter((platform) => bridges.some((bridge) => bridge.platforms.includes(platform))),
      needs: Object.assign({}, ...bridges.map((bridge) => bridge.needs), method.needs),
    };
  });
}

/** What every open connection says, however it reaches its device. */
type OpenBase = {
  readonly method: string;
  /** Its address: on its transport, or the member's key within its bridge. */
  readonly address: string;
  /** The connection's own settings: the method's config and the protocol's non-secret credentials. */
  readonly config: ConfigValues;
  /** Where this is running. */
  readonly platform: Platform;
};

/** A connection over a transport: its protocol's channel, guarded, and its secrets. */
export type DirectConnection = OpenBase & {
  readonly kind: 'direct';
  readonly protocol: string;
  readonly transport: string;
  readonly channel: Channel;
  /**
   * The connection's secrets, by field. `set` writes one its protocol
   * declares its session keeps (`kept: 'session'`) — a sign-in token, null to
   * forget it — and refuses any other: a person gives those.
   */
  readonly secrets: { get(field: string): string | null; set(field: string, value: string | null): void };
};

/**
 * A connection through a bridge: how to link to the member through its
 * bridge's session. The session links with a function of its own, called
 * whenever what it reads through the link has moved; whoever opened the
 * connection lets go of every link made through it when it closes.
 */
export type BridgedConnection = OpenBase & {
  readonly kind: 'bridged';
  link(changed: () => void): Promise<MemberLink>;
};

/**
 * A connection, open: what a device type's session and its `identify` are
 * handed — a channel over a transport, or a link through a bridge.
 *
 * The same shape wherever it is held, which is how the same device-type code
 * runs in the server and in the app.
 */
export type OpenConnection = DirectConnection | BridgedConnection;

/**
 * The channel of the kind a type speaks over, from its open connection — or
 * an error saying `why`, in a person's words: a connection through a
 * bridge, or of another kind, is not one it can speak over.
 */
export function channelOf<K extends ChannelKind>(connection: OpenConnection | null, kind: K, why: string): Extract<Channel, { kind: K }> {
  if (connection?.kind !== 'direct' || connection.channel.kind !== kind) throw new Error(why);
  return connection.channel as Extract<Channel, { kind: K }>;
}

/** A connection over a transport, with its channel and secrets — or an error saying `why`. */
export function directOf(connection: OpenConnection | null, why: string): DirectConnection {
  if (connection?.kind !== 'direct') throw new Error(why);
  return connection;
}

/**
 * A link to a member through its bridge, as the integration's own interface —
 * or an error saying `why`. `changed` is called whenever what it reads has
 * moved. The integration that declares the link declares the bridge that
 * hands it, so the type is its word.
 */
export async function linkOf<Link extends MemberLink>(connection: OpenConnection | null, changed: () => void, why: string): Promise<Link> {
  if (connection?.kind !== 'bridged') throw new Error(why);
  return (await connection.link(changed)) as Link;
}

/** What `identify` learns by reading a device once. */
export type Identified = {
  /**
   * The device's own permanent id, namespaced by protocol: `acme:AABBCC001122`.
   * Null for a service, which has none.
   */
  identity: string | null;
  /** The model it reports, to check it is the type being added. */
  model: string | null;
  /** What it calls itself. */
  name?: string;
  /** A sentence for the check step: "Battery 87 %, charging 120 W." */
  summary: string;
  /** Settings for the device worked out from what it said: a relay datapoint. */
  config?: ConfigValues;
  /** What it said about itself: firmware, serial. */
  info?: DeviceInfo;
  /** Its own description, for a device that describes itself — a standard's. */
  description?: DeviceDescription;
};

/** Namespaces a device's own id by the protocol that read it. */
export const identityOf = (protocol: string, id: string): string => `${protocol}:${id}`;

// --- opening a connection, the same in every holder ----------------------------

/**
 * A channel whose every outgoing frame passes the protocol's guard first.
 *
 * The guard is the one rule nobody may get around (docs/ARCHITECTURE.md §5),
 * so it is applied where the channel is opened, by every holder alike, rather
 * than trusted to each protocol's own code: a device type that wrote to the
 * channel directly would meet it all the same. A refusal is thrown, and nothing
 * reaches the transport.
 */
export function guardChannel(channel: Channel, protocol: Pick<Protocol, 'guard'>): Channel {
  const guard = protocol.guard?.bind(protocol);
  if (!guard || channel.kind === 'http') return channel;
  const check = (payload: Uint8Array) => {
    const refusal = guard(payload);
    if (refusal) throw new Error(refusal);
  };
  return new Proxy(channel, {
    get(target, key) {
      if (key === 'write' && target.kind === 'bytes') {
        return async (bytes: Uint8Array) => {
          check(bytes);
          await target.write(bytes);
        };
      }
      if (key === 'publish' && target.kind === 'messages') {
        return async (topic: string, payload: Uint8Array) => {
          check(payload);
          await target.publish(topic, payload);
        };
      }
      // Bound to the channel itself, so its getters and private state still work.
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Where transports are started: the server's host, or the app's registry. */
export type TransportSource = {
  start(id: string): Promise<Transport | null>;
  available(id: string): Availability;
};

/**
 * Opens a channel for one connection: the protocol's binding, over the
 * holder's transport, guarded. What every holder does before `identify` or a
 * session, written once. Its errors are sentences for the person adding or
 * using the device, and never name a transport or a protocol (§2).
 */
export async function openChannel(
  source: TransportSource,
  protocol: Protocol | null | undefined,
  connection: { transport: string; address: string; config?: Readonly<Record<string, unknown>> }
): Promise<Channel> {
  const binding = protocol?.bindings[connection.transport];
  if (!protocol || !binding) throw new Error('This device cannot be reached this way here: an update is needed');
  const transport = await source.start(connection.transport);
  if (!transport) {
    const why = source.available(connection.transport);
    throw new Error(why.ok ? 'This way of reaching devices did not start here' : why.reason);
  }
  return guardChannel(await transport.open(connection.address, binding.open(connection.address, connection.config ?? {})), protocol);
}
