/*
  Channels: what a transport hands a protocol. The whole seam between the
  two — a protocol speaks over one of three shapes and never opens one —
  which is why a protocol runs in the server and the app alike.
*/

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
/**
 * One message on a topic. `retained`: what the broker keeps on the topic,
 * sent to a new subscription — said before, not happening now: a press kept
 * in a device's state is not a press.
 */
export type ChannelMessage = { topic: string; payload: Uint8Array; at: string; retained?: boolean };
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
   * never typed by a person; every other origin is still refused. One may be
   * a whole domain — `https://*.example.com` — for a service whose hosts are
   * numbered and told at sign-in: any host under it, over HTTPS on its own
   * port, and nothing beside it.
   */
  alsoOrigins?: readonly string[];
};
