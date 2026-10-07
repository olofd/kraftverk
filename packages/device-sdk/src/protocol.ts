import type { OpenOptions } from './channel.ts';
import type { ConfigSchema } from './schema.ts';
import type { SetupAction } from './setup.ts';
import type { Recognised, Sighting } from './transport.ts';

/*
  Protocols: the language spoken over a transport — framing, encryption,
  message shapes — pure, with a binding for each transport it rides, and
  what it tells a message broker about the messages it carries.
*/

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
  /**
   * The topics it speaks for, when they share a beginning: `<base>/`.
   * Every topic under it is this protocol's and no other's — matched by this
   * policy alone. Absent for a protocol whose topics begin with the device's
   * own name (a station's MAC): matched among the others.
   */
  root?: string;
  /**
   * The client that speaks for this protocol's devices, by the name it signs
   * in to the broker as: only it may publish their topics, only it and the
   * server are sent them, and it holds a device while it is connected — what
   * keeps anything else on the home network, another bridge included, from
   * speaking for one or listening in. A station cannot sign in; a bridge —
   * one client for many devices — can.
   */
  signedIn?: string;
  /** The device a published topic comes from, and the channel within it; null when not this protocol's. */
  fromDevice(topic: string): { address: string; channel: string } | null;
  /** The device a subscription reveals: one subscribing to its own command topic. */
  subscribedBy(filter: string): string | null;
  /** The device a command topic is addressed to; null when the topic carries no command of this protocol's. */
  commandFor(topic: string): string | null;
  /**
   * Why a command must not reach a device, or null. Applied to the server's
   * own commands too. With its topic: for a bridge, the topic is what tells
   * switching a lamp from removing a device.
   */
  refuse(topic: string, payload: Uint8Array): string | null;
  /** A command, described. */
  describeCommand(topic: string, payload: Uint8Array): BrokerMessageNote;
  /**
   * Topics that carry a secret — a bridge's configuration with its network
   * key, a backup of its network: never kept on disk, never shown in the
   * journal, and (as every topic of a `signedIn` protocol) never sent to a
   * client that did not sign in.
   */
  secret?(topic: string): boolean;
  /**
   * Why restarting the broker — or the bridge behind it — now would cost
   * something, from what is kept on a topic: a device's firmware being
   * written. Null when nothing would. A deploy leaves them running while any
   * says so. Said without naming the device: the broker's health is open.
   */
  busy?(topic: string, payload: Uint8Array): string | null;
  /** A message from a device, described. */
  describeMessage(channel: string, payload: Uint8Array): BrokerMessageNote;
  /** Said when a known device has been absent a while: what to try. */
  absenceAdvice?: string;
};

/** How one protocol rides one transport. */
export type Binding = {
  /**
   * What to ask the transport for, to reach `address` — with the
   * connection's own settings, where what it needs was found rather than
   * fixed: the port a device announced.
   */
  open(address: string, config?: Readonly<Record<string, unknown>>): OpenOptions;
  /**
   * Whether a sighting is one of this protocol's devices, and what it says
   * about itself. Asked only of a sighting a way's matchers picked out
   * (`DirectMethod.discovery`), to confirm it and read it: a broadcast
   * decrypted, an advert's name.
   */
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
