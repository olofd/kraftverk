import type { ConfigValues, LinkEnd, LinkKind, NodeId, SavedDeviceId, SetupStepView } from '@kraftverk/device-sdk';

/*
  Adding a device: a draft part-way through its steps, what a check found,
  what a transport sighted, and a save.
*/

/** What the check step found. */
export type CheckOutcome =
  | { outcome: 'new'; summary: string; identity: string | null }
  | { outcome: 'yours'; summary: string; device: { id: SavedDeviceId; name: string } }
  | { outcome: 'removed'; summary: string; identity: string; devices: { id: SavedDeviceId; name: string; removedAt: string }[] }
  | { outcome: 'other-model'; summary: string; model: string; type: { id: string; name: string } | null }
  | { outcome: 'no-answer'; summary: string; saveAnyway: string | null };

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
};

/** One setup, part-way through, in the home. */
export type DraftView = {
  id: string;
  /** The node that will hold the connection: the master, or one that follows it. */
  heldBy: NodeId;
  typeId: string;
  methodId: string | null;
  plan: SetupStepView[];
  address: string | null;
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
  /** Add a new device; attach this connection to one you have; or bring a removed one back. */
  mode?: 'new' | 'attach' | 'restore';
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
  identified: { identity: string | null; model: string | null; name?: string; summary: string; config?: ConfigValues } | null;
  failure?: string;
  device?: ConfigValues;
  connection?: ConfigValues;
};

/** "Found near you": something a transport sees that nothing you have is reached by. */
export type FoundView = {
  transport: string;
  protocol: string;
  address: string;
  name: string;
  detail: string | null;
  identity: string | null;
  model: string | null;
  seenAt: string;
  types: { typeId: string; methodId: string; name: string; category: string }[];
};
