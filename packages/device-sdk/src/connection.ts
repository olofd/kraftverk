import type { DeviceDescription, DeviceInfo } from './description.ts';
import type { AuditSubject } from './identity.ts';
import type { ConfigSchema, ConfigValues } from './schema.ts';
import type { SetupAction, SetupStep } from './setup.ts';

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

// --- where code runs -----------------------------------------------------------

/**
 * A place a transport implementation can run.
 *
 * - `server` — the kraftverk server, under Bun.
 * - `web` — the app in a browser.
 * - `native` — the app on a phone.
 *
 * A connection method never says where it runs: that follows from which of
 * these have an implementation of its transport, and whether that one is
 * available right now.
 */
export type Platform = 'server' | 'web' | 'native';

export const PLATFORMS: readonly Platform[] = ['server', 'web', 'native'];

/** Whether something can be used here and now, and if not, a sentence saying why. */
export type Availability = { ok: true } | { ok: false; reason: string };

// --- channels: what a transport hands a protocol -------------------------------

type ChannelBase = {
  /** Whether the device at the other end is reachable right now. */
  readonly connected: boolean;
  /** Called whenever `connected` changes. Returns how to stop listening. */
  onConnectedChange(listener: (connected: boolean) => void): () => void;
  /** Lets go of the device. The transport, and every other channel on it, carry on. */
  close(): Promise<void>;
  /** Facts for the diagnostics screen: the characteristic in use, the peer. */
  describe?(): Record<string, unknown>;
};

/**
 * A byte stream to one device: a pair of Bluetooth characteristics, or a TCP
 * connection.
 *
 * Framing is the protocol's: bytes may arrive split or joined however the
 * transport pleases, and a protocol reassembles them.
 */
export type ByteChannel = ChannelBase & {
  readonly kind: 'bytes';
  write(bytes: Uint8Array): Promise<void>;
  onData(listener: (bytes: Uint8Array) => void): () => void;
  /**
   * Drops the connection and makes a fresh one. For protocols that negotiate
   * per connection — a session key agreed on connecting — and must start again to try
   * another version. Absent where a fresh connection means nothing.
   */
  reset?(): Promise<void>;
};

/** A message received on a topic. */
export type ChannelMessage = { topic: string; payload: Uint8Array; at: string };

/**
 * Topics on a message broker, scoped to one device.
 *
 * Which topics belong to the device is the protocol's knowledge — it builds
 * them from the address — so the channel takes whole topic names and filters.
 */
export type MessageChannel = ChannelBase & {
  readonly kind: 'messages';
  publish(topic: string, payload: Uint8Array): Promise<void>;
  subscribe(filter: string, listener: (message: ChannelMessage) => void): () => void;
};

/**
 * HTTP to one origin: the address — and to the few more its protocol declares
 * (`OpenOptions.alsoOrigins`: a sign-in host beside an API). A device type
 * reaches those hosts and no other through it, which is what keeps a weather
 * service from calling home.
 */
export type HttpChannel = ChannelBase & {
  readonly kind: 'http';
  /**
   * `path` is resolved against the address; a full URL may name a declared
   * origin instead. Any other origin is refused.
   */
  fetch(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
};

export type Channel = ByteChannel | MessageChannel | HttpChannel;
export type ChannelKind = Channel['kind'];

/**
 * What a protocol asks of a transport when opening a channel to one address.
 * Each transport reads the part it understands.
 */
export type OpenOptions = {
  /** Bluetooth: the GATT layouts the protocol speaks, tried in order. */
  gatt?: readonly { service: string; write: string; notify: string }[];
  /** Bluetooth: write with response. What some devices require. */
  writeWithResponse?: boolean;
  /** Bytes channels: the least time between two writes the device tolerates. */
  writeSpacingMs?: number;
  /** TCP: the port on the address. */
  port?: number;
  /**
   * HTTPS: the other origins of the same service the channel may reach besides
   * its address — a sign-in host beside the API. Declared by the protocol,
   * never typed by a person; every other origin is still refused.
   */
  alsoOrigins?: readonly string[];
};

// --- finding devices ----------------------------------------------------------

/**
 * Something a transport can see: a peripheral advertising, a client on the
 * broker, a broadcast on the home network.
 *
 * Not a device — evidence that something is reachable. It becomes one only
 * when a person adds it, and it is never stored (docs/DATA-MODEL.md §3).
 */
export type Sighting = {
  transport: string;
  /** What the transport knows it by, and what `open` takes: a MAC, an IP, a browser's handle. */
  address: string;
  /** When it was last heard. */
  seenAt: string;
  /** What it calls itself, when it says. */
  name?: string;
  /** Bluetooth signal strength. */
  rssi?: number;
  /**
   * The transport's evidence, for a protocol to recognise it by: advertised
   * services, the protocol a broker client speaks, a broadcast's bytes (hex).
   * Plain data, so it can cross from the server to the app.
   */
  facts: Readonly<Record<string, unknown>>;
};

/** What a protocol makes of a sighting it recognises as one of its own. */
export type Recognised = {
  /** A name to list it under. */
  name: string;
  /** The device's own permanent id, when the sighting already carries it. */
  identity?: string;
  /** The model, when the sighting says. */
  model?: string;
  /** A second line: a protocol version, an address. */
  detail?: string;
  /**
   * Connection settings the sighting already reveals, applied to the draft
   * when it is chosen: a device's id and protocol version.
   */
  config?: ConfigValues;
};

/** What a transport should look for on a protocol's behalf. */
export type SightingFilter = {
  /** Bluetooth: advertised GATT services. */
  services?: readonly string[];
  /** Bluetooth: advertised name prefixes, for choosers that cannot match otherwise. */
  namePrefixes?: readonly string[];
  /** Home network: UDP ports devices broadcast on. */
  udpPorts?: readonly number[];
};

// --- transports ---------------------------------------------------------------

/** What a transport is, as data: the same on every platform. */
export type TransportDefinition = {
  /** `mqtt`, `ble`, `lan`, `https`. Stable forever: connections name it. */
  id: string;
  /** How people say it, in a sentence: "Wi-Fi", "Bluetooth", "the home network". */
  label: string;
  channel: ChannelKind;
  /**
   * An address means one physical thing, so only one device may claim it.
   * True for a broker client, a peripheral, an IP; false for a web API.
   */
  exclusive: boolean;
  /** Where it has an implementation. */
  platforms: readonly Platform[];
  /**
   * How setup finds a device on it, per platform: a live `list`, the
   * platform's own `chooser` (a browser's Bluetooth picker), or `none` — the
   * address is typed or fixed, as a web API's is.
   */
  discovery: Partial<Record<Platform, 'list' | 'chooser' | 'none'>>;
};

/**
 * One transport, running on one platform.
 *
 * Started on demand by its platform's host, at most once per process, and
 * shared by every connection over it: there is one radio and one broker.
 */
export type Transport = {
  readonly definition: TransportDefinition;
  /** Whether it can be used here, now — and if not, why, in words a person can act on. */
  available(): Availability;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** What can be seen, as a live list. Returns how to stop watching. */
  watch?(filter: SightingFilter, listener: (sightings: readonly Sighting[]) => void): () => void;
  /** The platform's own chooser, for platforms that show one. Null when it is dismissed. */
  choose?(filter: SightingFilter): Promise<Sighting | null>;
  /**
   * A channel to one device. Lenient: a device out of range is a channel that
   * is not connected yet and keeps trying, not a failure.
   */
  open(address: string, options: OpenOptions): Promise<Channel>;
  /** Values setup instructions may show: the broker's address and port. */
  values?(): Readonly<Record<string, string>>;
  /** Read-only diagnostics, by name. */
  diagnostics?: Readonly<Record<string, (query: Readonly<Record<string, string>>) => Promise<unknown>>>;
};

/** What a platform's host hands a transport it starts. */
export type TransportContext = {
  /** The process's environment: a transport reads its own settings from it. */
  env: Readonly<Record<string, string | undefined>>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /**
   * Records something security-relevant in the audit timeline: a command the
   * broker refused, a client that presented the wrong secret.
   */
  audit(entry: { kind: string; actor: string; summary: string; detail?: unknown } & AuditSubject): void;
  /** What this transport keeps between runs, its own and no other transport's. */
  store: TransportStore;
};

/**
 * What a transport keeps between runs: a Bluetooth bond, a Matter fabric, a
 * broker's credentials. Small text values under keys of its choosing, scoped
 * to it by the host — the server's database, an app's own storage — so one
 * transport can neither read nor clobber another's.
 */
export type TransportStore = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
};

/** A store kept in memory: for tests, and a host with nowhere else to keep one. */
export function memoryTransportStore(): TransportStore {
  const kept = new Map<string, string>();
  return { get: (key) => kept.get(key) ?? null, set: (key, value) => void kept.set(key, value), delete: (key) => void kept.delete(key) };
}

/**
 * What a transport package's entry for one platform exports by default: how
 * to make the transport, given its context.
 */
export type TransportFactory = (context: TransportContext) => Transport;

// --- protocols ----------------------------------------------------------------

/** What a message broker makes of one message, as a protocol explains it. */
export type BrokerMessageNote = {
  /** One line for the broker's journal. */
  summary: string;
  /** How loudly: a poll is `debug`, a write `info`, an exception `warn`. */
  level: 'debug' | 'info' | 'warn';
  /** A command awaiting a reply, by what the reply will look like: `input`, `write:26`. */
  awaits?: string;
  /** The awaited reply this message is, when it is one. */
  answers?: string;
  /**
   * A device may send this unasked — telemetry pushed on its own schedule. When
   * nothing asked for it, the broker counts it and measures how often it comes.
   */
  periodic?: boolean;
};

/**
 * A protocol's rules for a message broker: which topics are its devices', which
 * carry commands to them, and which commands must never be delivered.
 *
 * The broker applies every installed protocol's policy, and knows no protocol
 * of its own (docs/BROKER.md). It also holds a rule that needs none: no
 * client but the server may publish anything another device would receive, so
 * devices on the broker can be commanded by nothing else, whatever policies
 * are loaded.
 */
export type MessageBrokerPolicy = {
  protocol: string;
  /** The device a published topic comes from, and the channel within it; null when not this protocol's. */
  fromDevice(topic: string): { address: string; channel: string } | null;
  /** The device a subscription reveals: one subscribing to its own command topic. */
  subscribedBy(filter: string): string | null;
  /** The device a command topic is addressed to; null when the topic carries no command of this protocol's. */
  commandFor(topic: string): string | null;
  /** Why a command must not reach a device, or null. Applied to the server's own commands too. */
  refuse(payload: Uint8Array): string | null;
  /** A command, described. */
  describeCommand(payload: Uint8Array): BrokerMessageNote;
  /** A message from a device, described. */
  describeMessage(channel: string, payload: Uint8Array): BrokerMessageNote;
  /** Said when a known device has been absent a while: what to try. */
  absenceAdvice?: string;
};

/** How one protocol rides one transport. */
export type Binding = {
  /** What to ask the transport for, to reach `address`. */
  open(address: string): OpenOptions;
  /** What discovery should look for. */
  filter?: SightingFilter;
  /** Whether a sighting is one of this protocol's devices, and what it says about itself. */
  recognise(sighting: Sighting): Recognised | null;
  /**
   * What to do to a device before it can be found this way. `{name}` in the
   * body is filled from the transport's `values()`.
   */
  instructions?: { title: string; body: string };
  /**
   * An address typed by hand, normalised — or null when it cannot be one.
   * Absent: this transport's addresses cannot be typed.
   */
  parseAddress?(input: string): string | null;
  /** How the typed address is asked for: "IP address", "MAC address". */
  addressLabel?: string;
  /** Message transports only: the protocol's rules for the broker. */
  broker?: MessageBrokerPolicy;
};

/**
 * A protocol: pure code, no I/O and no product meaning.
 *
 * It has a binding for each transport it rides. What setup must ask for —
 * a device's local key — is its `credentials`, stored with the connection, the
 * secret fields encrypted. `guard` is the one frame-level rule no one may get
 * around: every holder and the broker apply it to what they carry.
 */
export type Protocol = {
  /** `acme-link`: what the protocol is called. Stable forever. */
  readonly id: string;
  readonly label: string;
  readonly bindings: Readonly<Record<string, Binding>>;
  readonly credentials?: {
    schema: ConfigSchema;
    actions?: readonly SetupAction[];
    /**
     * Asked before the device is chosen. For a protocol whose account lists
     * the devices — names, keys, which is which — signing in is how the device
     * is found, and choosing it on the network afterwards is only needed when
     * the account could not say where it is.
     */
    first?: boolean;
    /** What the step is called: "Your account with the maker's app". "Credentials" when absent. */
    title?: string;
  };
  guard?(payload: Uint8Array): string | null;
};

// --- connection methods: what a device type declares ---------------------------

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
   * Held only by a server, and why: "your account password stays on your server".
   * An app is not offered it, and the server refuses to save one an app would
   * hold — a vendor account's password does not belong in a browser, and some
   * clouds do not answer a web page at all.
   */
  serverOnly?: string;
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

/** Every way a type can be added: its own, then simulated. */
export const methodsOf = (type: { readonly connections: readonly ConnectionMethod[] }): ConnectionMethod[] => [...type.connections, SIMULATED_METHOD];

/** One of a type's ways, by id, simulated included. */
export const methodOf = (type: { readonly connections: readonly ConnectionMethod[] }, id: string): ConnectionMethod | null =>
  methodsOf(type).find((method) => method.id === id) ?? null;

/** Whether a connection is simulated: its holder opens the type's simulator, and reaches nothing. */
export const isSimulated = (connection: { readonly transport: string }): boolean => connection.transport === SIMULATED_TRANSPORT;

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
