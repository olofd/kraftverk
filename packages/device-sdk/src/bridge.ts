import type { Channel } from './channel.ts';
import { guardChannel } from './connection.ts';
import type { Protocol } from './protocol.ts';

/*
  A bridge: a device through which other devices are reached — its members
  (docs/PLAN-INTEGRATIONS.md §4.3). An account and the scooters on it, a
  gateway and the plugs paired with it. Hardware, a service or an
  account may be one; being a bridge is a role, not a kind.

  A member is reached over a transport of its own, `bridge`, which is no
  package: the bridge's open session is it. Its connection names the bridge
  device it goes through, and its address is the member's key within it. A
  member is held wherever its bridge is — a server, a browser, a phone — and
  its protocol rides the bridge's channel as it rides any transport's: by a
  binding, guarded.
*/

/** The transport every connection through a bridge rides: the bridge's own open session, not a package. */
export const BRIDGE_TRANSPORT = 'bridge';

/** What a type that is a bridge declares. */
export type BridgeSpec = {
  /**
   * The type a member becomes when no installed type claims it: the
   * platform's generic one. Absent: a member nothing claims is not offered.
   */
  readonly fallback?: string;
};

/** One device behind a bridge, as its session sees it now. Live, never stored: a sighting until a device claims it. */
export type Member = {
  /** Its key within the bridge: its address, stable for as long as the bridge says so. */
  readonly key: string;
  /** What its owner calls it, where the bridge knows: offered as its name. */
  readonly name: string | null;
  /** The model it reports: matched against the models types claim. */
  readonly model: string | null;
  /** Its own permanent id, where the bridge knows it: what makes it one device with another way to it. */
  readonly identity: string | null;
  /** The type it is, where the bridge itself knows. */
  readonly typeId: string | null;
};

/** What a bridge's open session offers the devices behind it. */
export interface BridgeHost {
  /** Who is behind it now. */
  members(): readonly Member[];
  /** Called when who is behind it changes. Returns how to stop listening. */
  onMembersChange(listener: () => void): () => void;
  /** A channel to one member, for its session: closed by whoever opened it. */
  open(member: string): Promise<Channel>;
}

/** Whether a connection rides a bridge: held wherever its bridge is, opened by the bridge's session. */
export const isBridged = (connection: { readonly transport: string }): boolean => connection.transport === BRIDGE_TRANSPORT;

/**
 * Opens a member's channel: the protocol's binding for the bridge, over the
 * bridge's open session, guarded — as `openChannel` does over a transport.
 * Its errors are sentences for a person.
 */
export async function openThroughBridge(host: BridgeHost, protocol: Protocol | null | undefined, connection: { address: string }): Promise<Channel> {
  if (!protocol?.bindings[BRIDGE_TRANSPORT]) throw new Error('This device cannot be reached through its bridge here: an update is needed');
  return guardChannel(await host.open(connection.address), protocol);
}
