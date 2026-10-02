import type { AuditSubject, Availability, DeviceDescription, DeviceInfo, NodeId, Platform, PolicyValueName, PolicyValueSpec, Reading, ResourceKind, TransportDefinition, Value } from '@kraftverk/device-sdk';

import type { Holder, Refused } from './devices.ts';

/*
  The nodes of a home and what they share: the transports each runs, a node
  joining, the home and its master, readings a node sends for a way it
  holds, the timeline, the server's log and the home's policy values.
*/

export type TransportView = TransportDefinition & {
  /** Whose it is: the master's, or this node's own, which it holds the master's connections over. */
  holder: Holder;
  running: boolean;
  availability: Availability;
  values: Record<string, string>;
  /** Names of its read-only diagnostics. */
  diagnostics: string[];
};

export type TransportList = {
  readOnly: boolean;
  transports: TransportView[];
  refused: Refused[];
};

/**
 * A kraftverk node of the home (docs/DATA-MODEL.md §3): the hub running
 * somewhere, holding connections — an always-on machine on the network, a
 * phone, a browser — with what it declares it is.
 */
export type NodeView = {
  id: NodeId;
  /** "Garage NAS", "Chrome on Windows". */
  name: string;
  /** What its transports' entries are for: a system process, a browser's page, a phone. */
  platform: Platform;
  /** What it reaches devices over, as it last said. */
  transports: string[];
  /** It runs while nobody looks. */
  alwaysOn: boolean;
  /** Others connect to it. */
  reachable: boolean;
  /** What must stay put may be kept on it. */
  trusted: boolean;
  /** The home's master: the node whose database is the home's. */
  master: boolean;
  /** Joined from the asker's own account, and not the master: theirs to forget. */
  yours: boolean;
  createdAt: string;
  lastSeenAt: string;
};

/** A node joining a home, saying what it is: by its own id, the same in every home it is part of. */
export type NodeJoin = Pick<NodeView, 'id' | 'name' | 'platform' | 'transports' | 'alwaysOn' | 'reachable' | 'trusted'>;

/** The home: what its people call it, and which node is its master. */
export type HomeView = { id: string; name: string; master: NodeId; createdAt: string };

/** One line of the server's own log. */
export type ServerLogLine = { at: string; level: 'debug' | 'info' | 'warn' | 'error'; text: string };

/** A line a node that follows sends for the timeline: the master adds who sent it. */
export type AuditUpload = { at: string; kind: string; summary: string; detail?: unknown } & AuditSubject;

/** One line of the timeline: who did what, to what, and what came of it. */
export type AuditEntry = {
  id: number;
  at: string;
  kind: string;
  actor: string;
  /** What it is about — a device, a node, an automation, an account — or nothing. */
  resourceKind: ResourceKind | null;
  resource: string | null;
  summary: string;
  detail?: unknown;
};

/**
 * `GET /policy`: a number this home decides that declarations name — how much
 * is a load worth confirming — with what it is now and what it would be unset.
 * `PUT /policy/:name` with `{ value }` sets it; `null` puts it back.
 */
export type PolicyValueView = PolicyValueSpec & { name: PolicyValueName; value: number };

/** What a node that follows sends for a connection it holds: what it read, who the device said it is, what it is, and what it said happened. */
export type HeldReadings = {
  nodeId: string;
  connectionId: string;
  identity?: string | null;
  readings: Reading[];
  /** Sent only when the device describes itself: the type's own the home has already. */
  description?: DeviceDescription;
  info?: DeviceInfo | null;
  events?: { id: string; part: string | null; data: Record<string, Value> | null; at: string }[];
};

/** What became of them: live ones the device's state now, queued ones history, the rest refused as out of range. */
export type HeldReadingsTaken = { live: number; history: number; refused: number };
