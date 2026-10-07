/*
  A bridge: a device through which other devices are reached — its members
  (docs/PLAN-INTEGRATIONS.md §4.3). An account and the scooters on it, a
  gateway and the plugs paired with it. Hardware, a service or an
  account may be one; being a bridge is a role, not a kind.

  A member is reached by calls, not messages (§1.1): the bridge's session
  hands each member a **link** — an object of the integration's own, with
  plain methods (`report()`, `raw()`) — and calls the one function the
  member gave it when what the link reads has moved. The member's session
  reads it, and tells its holder as any session does. No topics, no values
  turned into bytes and back, no pretend transport.

  A member's way names the bridge types it goes through (`through`) instead
  of a protocol and a transport; its connection names the bridge device, and
  its address is the member's key within it. It is held wherever its bridge
  is — a server, a browser, a phone.
*/

/**
 * What a connection through a bridge is kept as, where a connection names a
 * transport: none is opened for it — its bridge's session is the way.
 */
export const BRIDGE_TRANSPORT = 'bridge';

/** What a type that is a bridge declares. */
export type BridgeSpec = {
  /**
   * The type a member becomes when no installed type claims it: the
   * integration's generic one. Absent: a member nothing claims is not offered.
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
  /** What it is, in a few words, where the bridge knows: "IKEA E1603 smart plug". */
  readonly about: string | null;
  /** Joining and not ready yet: its bridge is still asking it what it is. Offered once it is ready. */
  readonly joining: boolean;
};

/**
 * A bridge new devices join — a Zigbee coordinator: open for a while, then
 * closed again. Opening it changes what can join the home, so it is run as
 * a tool that writes is: refused while read-only, and on the timeline.
 */
export type Joining = {
  /** Lets devices join for `seconds`; 0 closes it now. Resolves once the bridge says it did, with until when they may now: null when closed. */
  open(seconds: number): Promise<string | null>;
  /** Until when devices may join, or null when they may not. */
  until(): string | null;
  /** The longest it may be open at once, in seconds: Zigbee's 254. */
  readonly maxSeconds: number;
};

/**
 * What every link to a member has: a way to let go of it. The rest is the
 * integration's own interface — what its members read and ask — declared
 * beside its bridge type and imported by the device packages built on it.
 */
export type MemberLink = {
  /** Lets go: the bridge stops working for this member, until linked again. */
  close(): void;
};

/**
 * What a bridge's open session offers the devices behind it: who they are,
 * and a link to each. Every session of a bridge type has it, its
 * simulator's included.
 */
export interface Bridge<Link extends MemberLink = MemberLink> {
  /** Who is behind it now. Read again whenever its session says it changed (`ctx.changed()`). */
  members(): readonly Member[];
  /**
   * A link to one member, for its session and for the check step: `changed`
   * is called whenever what it reads through the link has moved. Rejects,
   * with a sentence for a person, for a key that is not a member.
   */
  link(member: string, changed: () => void): Promise<Link>;
  /** For a bridge new devices join: letting them, and until when. Read again when its session says it changed. */
  readonly join?: Joining;
}

/** Whether a kept connection goes through a bridge: held wherever its bridge is, opened by the bridge's session. */
export const isBridged = (connection: { readonly transport: string }): boolean => connection.transport === BRIDGE_TRANSPORT;

/**
 * A link that lets go once, however often it is closed: what its holder
 * hands a member's session, so the session closing it and the holder closing
 * what is left are the same single close.
 */
export function closingOnce<Link extends MemberLink>(link: Link): Link {
  let closed = false;
  return new Proxy(link, {
    get(target, key) {
      if (key === 'close') {
        return () => {
          if (closed) return;
          closed = true;
          target.close();
        };
      }
      // Bound to the link itself, so a class's methods and private state still work.
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
