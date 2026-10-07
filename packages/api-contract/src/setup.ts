import type { ConfigValues, LinkEnd, LinkKind, NodeId, SavedDeviceId, SetupStepView } from '@kraftverk/device-sdk';

/*
  Adding a device: a draft part-way through its steps, what a check found,
  what a transport sighted, and a save.
*/

/** What the check step found. */
export type CheckOutcome =
  | { outcome: 'new'; summary: string; identity: string | null }
  | {
      outcome: 'yours';
      summary: string;
      device: { id: SavedDeviceId; name: string };
      /**
       * When the device you have is of another type than the one being added
       * — the same Zigbee plug, once behind one vendor's gateway, now behind the
       * dongle — what moving it to this type keeps and changes. Null when it
       * is of this type already.
       */
      move: MoveView | null;
    }
  | { outcome: 'removed'; summary: string; identity: string; devices: { id: SavedDeviceId; name: string; removedAt: string }[] }
  | { outcome: 'other-model'; summary: string; model: string; type: { id: string; name: string } | null }
  | { outcome: 'no-answer'; summary: string; saveAnyway: string | null };

/**
 * A device changing what it is, as a person sees it before anything moves
 * (docs/PLAN-ZIGBEE.md §2.1): each attribute it has ever had and where its
 * history goes, each part, the links and automations that use it, and the
 * ways it is reached that the new type has no way for.
 */
export type MoveView = {
  device: { id: SavedDeviceId; name: string };
  from: { typeId: string; name: string };
  to: { typeId: string; name: string };
  /** Each attribute it has had: its history moves to `to`, or stays where it is (`to` null) — still kept, no longer reported. */
  attributes: { key: string; label: string; to: string | null; toLabel: string | null; how: 'meaning' | 'key' | 'label' | null }[];
  /** Each part of it: the part it becomes, or none. */
  parts: { id: string; label: string; to: string | null; toLabel: string | null }[];
  /** Its links: kept, re-pointed to the part it becomes, or removed — with why. */
  links: { id: string; summary: string; kept: boolean }[];
  /** The automations that use it: still filled, or needing a part chosen again. */
  automations: { id: string; name: string; kept: boolean }[];
  /** Its ways that the new type has none for: removed when it moves. */
  connectionsRemoved: { id: string; label: string }[];
};

/** Something a transport can see that this type's protocol recognises. */
export type SightingView = {
  address: string;
  name: string;
  detail: string | null;
  identity: string | null;
  seenAt: string;
  rssi: number | null;
  /** A device you already have is reached at this address. */
  claimedBy: { id: SavedDeviceId; name: string } | null;
  /** For a member of a bridge: the bridge it is behind — its address is its key there. Null for what a transport sees. */
  through: { id: SavedDeviceId; name: string } | null;
};

/** One setup, part-way through, in the home. */
export type DraftView = {
  id: string;
  /**
   * A way you have, set up again — signed in again with a new password, its
   * key fetched again — rather than a device added: its device and the
   * connection it changes. Null while adding.
   */
  again: { deviceId: SavedDeviceId; connectionId: string; name: string } | null;
  /** The node that will hold the connection: the master, or one that follows it. */
  heldBy: NodeId;
  typeId: string;
  methodId: string | null;
  plan: SetupStepView[];
  address: string | null;
  /** For a member of a bridge: the bridge it is reached through, once chosen. */
  through: SavedDeviceId | null;
  device: Record<string, unknown>;
  connection: Record<string, unknown>;
  /** Secret fields held so far, by name. */
  secrets: string[];
  checked: CheckOutcome | null;
  expiresAt: string;
};

/** `POST /setup/:id/save`, as sent: the name may be empty (the type's name is used) and `mode` defaults to `new`. */
export type SaveInput = {
  name?: string;
  /**
   * Add a new device; attach this connection to one you have; bring a
   * removed one back; or move one you have to this type, with this
   * connection — its history mapped as the check's `move` said.
   */
  mode?: 'new' | 'attach' | 'restore' | 'move';
  deviceId?: string;
  /** Save after a check the type expects to fail sometimes: a sleeping station. */
  anyway?: boolean;
  /** Links from or to the device being saved: which of its parts, and which part of a device you have. */
  links?: { kind: LinkKind; part: string; other: LinkEnd<string>; role: 'source' | 'target' }[];
  /** Whether the connection's secrets may leave in an export as plain text: off unless chosen, and warned against (docs/CONFIG.md). */
  secretsExportable?: boolean;
};

/** What a node that follows learnt by reading a device itself, for a connection it will hold. */
export type HeldSetupInput = {
  nodeId: string;
  typeId: string;
  methodId: string;
  address: string;
  /** For a member of a bridge the node holds: the bridge, whose key `address` is. */
  through?: string;
  identified: { identity: string | null; model: string | null; name?: string; summary: string; config?: ConfigValues } | null;
  failure?: string;
  device?: ConfigValues;
  connection?: ConfigValues;
};

/**
 * Where something was found: on a transport at an address; or behind a bridge,
 * by its key there. What a found thing is ignored, and brought back, by.
 */
export type FoundAt = { transport: string; through: string | null; address: string };

/** Something an integration keeps between setups, as its page lists it: what it is, and when — never its value. */
export type KeptView = { key: string; label: string; at: string };

/** "Found near you": something a transport sees, or a member behind a bridge, that nothing you have is reached by. */
export type FoundView = {
  transport: string;
  /** The protocol that recognised it; none for a member of a bridge, which is read through a link. */
  protocol: string | null;
  address: string;
  /** For a member of a bridge: the bridge it is behind. */
  through: { id: SavedDeviceId; name: string } | null;
  /** Said not to be offered again: listed apart, where it can be brought back. */
  ignored: boolean;
  name: string;
  detail: string | null;
  identity: string | null;
  model: string | null;
  /** What it is, in a few words, where its bridge knows. */
  about: string | null;
  /** Still joining its bridge: not ready to add until its bridge knows what it is. */
  joining: boolean;
  seenAt: string;
  types: { typeId: string; methodId: string; name: string; category: string }[];
};
