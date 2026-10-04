import type { Channel } from './channel.ts';
import type { DeviceDescription, DeviceInfo } from './description.ts';
import { PLATFORMS, type NodeNeeds, type Platform } from './node.ts';
import type { Protocol } from './protocol.ts';
import type { ConfigSchema, ConfigValues } from './schema.ts';
import type { SetupStep } from './setup.ts';
import type { Availability, Transport, TransportDefinition } from './transport.ts';

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
 * One way a device type can be reached: its protocol over one transport.
 *
 * Declared as a pair, not as two lists, because not every protocol rides every
 * transport. Where it runs is never said here: a method is offered wherever its
 * transport is available (docs/ARCHITECTURE.md, decision 8).
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

export type ConnectionMethod = {
  /** `wifi`, `bluetooth`, `lan`. Stable forever within the type: connections name it. */
  id: string;
  /** How people say it: "Wi-Fi", "Bluetooth". The holder is added on screen. */
  label: string;
  /** One line on what this way needs or gives. */
  description?: string;
  protocol: string;
  transport: string;
  /** Whether it needs anything beyond your home network: said on the add screen before anything is chosen. */
  reach: Reach;
  /** The one to suggest, when a type has several. */
  recommended?: boolean;
  /**
   * A fixed address — a web API's origin — so nothing is chosen. Absent for a
   * device, which is found.
   */
  address?: string;
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

export const SIMULATED_METHOD: ConnectionMethod = {
  id: SIMULATED_METHOD_ID,
  label: 'Simulated',
  description: 'No hardware: its simulator stands in, to try it out.',
  protocol: SIMULATED_TRANSPORT,
  transport: SIMULATED_TRANSPORT,
  address: SIMULATED_ADDRESS,
  reach: 'local',
};

/** A type's simulated way: chosen with what its own simulator is set up with, when it is set up with anything. */
export const simulatedMethodOf = (type: { readonly simulation?: ConfigSchema }): ConnectionMethod =>
  type.simulation && Object.keys(type.simulation.fields).length ? { ...SIMULATED_METHOD, config: type.simulation } : SIMULATED_METHOD;

type HasWays = { readonly connections: readonly ConnectionMethod[]; readonly simulation?: ConfigSchema };

/** Every way a type can be added: its own, then simulated. */
export const methodsOf = (type: HasWays): ConnectionMethod[] => [...type.connections, simulatedMethodOf(type)];

/** One of a type's ways, by id, simulated included. */
export const methodOf = (type: HasWays, id: string): ConnectionMethod | null => methodsOf(type).find((method) => method.id === id) ?? null;

/** Whether a connection is simulated: its holder opens the type's simulator, and reaches nothing. */
export const isSimulated = (connection: { readonly transport: string }): boolean => connection.transport === SIMULATED_TRANSPORT;

/**
 * The runtimes a method can be held on at all: those its transport has an
 * entry for. A simulated one reaches nothing, and is held anywhere.
 */
export function platformsOf(method: ConnectionMethod, transport: Pick<TransportDefinition, 'platforms'> | null): Platform[] {
  if (isSimulated(method)) return [...PLATFORMS];
  return [...(transport?.platforms ?? [])];
}

/**
 * A connection, open: what a device type's session and its `identify` are handed.
 *
 * The same shape wherever it is held, which is how the same device-type code
 * runs in the server and in the app.
 */
export type OpenConnection = {
  readonly method: string;
  readonly protocol: string;
  readonly transport: string;
  readonly address: string;
  readonly channel: Channel;
  /** The connection's own settings: the method's config and the protocol's non-secret credentials. */
  readonly config: ConfigValues;
  /** The connection's secrets, by field. */
  readonly secrets: { get(field: string): string | null };
  /** Where this is running. */
  readonly platform: Platform;
};

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
  connection: { transport: string; address: string }
): Promise<Channel> {
  const binding = protocol?.bindings[connection.transport];
  if (!protocol || !binding) throw new Error('This device cannot be reached this way here: an update is needed');
  const transport = await source.start(connection.transport);
  if (!transport) {
    const why = source.available(connection.transport);
    throw new Error(why.ok ? 'This way of reaching devices did not start here' : why.reason);
  }
  return guardChannel(await transport.open(connection.address, binding.open(connection.address)), protocol);
}
