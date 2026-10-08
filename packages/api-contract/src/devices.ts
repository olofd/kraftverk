import type { Availability, CapabilityId, CategorySpec, ConnectionHealth, ConnectionId, DescriptionSource, DeviceKind, DeviceDescription, DeviceInfo, DeviceTypeMeta, DeviceTypeView, IntegrationInfo, LinkEnd, LinkId, LinkKind, NodeId, Placement, Reading, SavedDeviceId, ToolSpec, TransportDefinition, TypeSource, Value } from '@kraftverk/device-sdk';

/*
  The devices you have, as a home answers for them: a device with its
  connections and links, the types it can be, its history and changes, and
  what a command, a write or a tool is sent with.
*/

/** One way a device is reached, as its page lists it. */
export type ConnectionView = {
  id: ConnectionId;
  method: string;
  /** "Wi-Fi", from the type. */
  methodLabel: string;
  transport: string;
  /**
   * Which node holds it, as the node asking sees it: the home's `master`;
   * `this-node`, the one asking, holding it for the master; or another
   * `node` of the home — a phone, a browser, another machine.
   */
  heldBy: { kind: HeldBy | 'node'; id: NodeId; name: string };
  /**
   * The bridge it goes through, for a member of one — a scooter through its
   * account: then `heldBy` is whichever node holds the bridge, and
   * `address` is the member's key within it. Null for a way a node holds itself.
   */
  through: { id: SavedDeviceId; key: string; name: string } | null;
  address: string;
  priority: number;
  /** Whether it reaches the device right now; null when nobody is trying it. */
  reachable: boolean | null;
  /** The one the device is using right now: the reachable one highest in the list. */
  inUse: boolean;
  lastConnectedAt: string | null;
  /** Which secrets it has, by field — never their values. */
  secrets: string[];
  /** Whether its secrets may leave in an export as plain text: its owner's choice, off unless chosen (docs/CONFIG.md). */
  secretsExportable: boolean;
  config: Record<string, unknown>;
};

/** A link as one of its devices' pages lists it: which of its parts, and which part of which other device. */
export type LinkView = {
  id: LinkId;
  kind: LinkKind;
  /** Whether this device is the link's source or its target. */
  role: 'source' | 'target';
  /** The part of this device the link joins. */
  part: string;
  other: { id: SavedDeviceId; name: string; part: string; partLabel: string };
};

/** One place a device was located, and when; within how many metres, when it said. */
export type TrackPointView = { at: string; latitude: number; longitude: number; accuracy: number | null };

/** A tool of the device's type that its session can run now, as data. */
export type ToolView = ToolSpec & { name: string };

/** A saved device, joined to what it is doing right now. */
export type DeviceView = {
  id: SavedDeviceId;
  /** Its name in configuration: what a file and an import know it by (docs/CONFIG.md). */
  key: string;
  typeId: string;
  /** Whether an installed type claims it. */
  installed: boolean;
  name: string;
  identity: string | null;
  addedAt: string;
  removedAt: string | null;
  /** When its owner paused it: kept, and not reached, until resumed. Null when it is not paused. */
  pausedAt: string | null;
  /** How many days where it has been is kept, its owner's choice: 1 to 366. Null: none of it is. */
  trackDays: number | null;
  kind: DeviceKind;
  /** The integration its type is on: where its accounts are managed, and its own screens. Null for a type not installed. */
  integration: IntegrationInfo | null;
  meta: Pick<DeviceTypeMeta, 'name' | 'brand' | 'icon' | 'support'> & { category: string };
  /** What it is: its parts, their attributes — settings among them — and its events. Its own when it reports one. */
  description: DeviceDescription;
  /** Whose word that is: its type's, for its config, or the device's own — which can change while it runs (a pack plugged in). */
  descriptionSource: DescriptionSource;
  /** Every capability any of its parts offers. */
  capabilities: readonly CapabilityId[];
  /** What it has said about itself: firmware, serial. */
  info: DeviceInfo | null;
  config: Record<string, unknown>;
  connections: ConnectionView[];
  links: LinkView[];
  /** The tools of its type its session can run now: what each asks for, what it answers, and whether it changes the device. */
  tools: ToolView[];
  /** For a bridge new devices join (a Zigbee coordinator), held here: until when they may, and for how long at most. Null for any other. */
  joins: { until: string | null; maxSeconds: number } | null;
  readings: Reading[];
  health: ConnectionHealth;
  /**
   * Whether the node holding it refuses every write to hardware now — its
   * own switch, off until someone says — and so whether a screen draws its
   * controls as read only. Never for a simulated one, which reaches no
   * hardware.
   */
  readOnly: boolean;
  /** Which picture it shows: its owner's pick, else its type's first (`type:0`). */
  picture: PictureRef;
};

/**
 * A picture of a device, by where it comes from:
 *
 * - `type:N` — its type's Nth picture, counting from 0: from its package
 *   (`kraftverk.assets.images`), shipped with the app. One no longer there is
 *   shown as the first.
 * - `own:<id>` — reserved for a photo its owner takes of it: stored and served
 *   by the server, at `/devices/:id/pictures/<id>`. Not built yet; nothing
 *   else about a device changes when it is.
 */
export type PictureRef = `type:${number}` | `own:${string}`;

/** `PUT /devices/:id/picture`: which picture to show. */
export type PictureChoice = { picture: PictureRef };

/**
 * Which node would hold a way in to a device, as the node asking sees it:
 * the home's master, or this node, holding it for the master with what it
 * reaches itself — its own radio (docs/PLAN-SHARED-CORE.md, phase 6).
 */
export type HeldBy = 'master' | 'this-node';

/**
 * A home this node keeps beside the one it shows, to bring into it
 * (docs/PLAN-SHARED-CORE.md, phase 6h): `this-node`, the home it kept
 * itself before it followed a master, moving to the master; `copy`, the
 * copy it kept of the master it followed last, staying with this node. Only
 * an app keeps either: a server's home has neither, and says so.
 */
export type FamilyElsewhere = 'this-node' | 'copy';

/** What a home this node keeps beside the one it shows has: what bringing it in would bring. Null when there is none, or it has been brought. */
export type ElsewhereView = { from: FamilyElsewhere; devices: number; automations: number } | null;

/**
 * One way a type can be added: its method, which node would hold it, whether
 * that node can hold it at all — what the way needs of the node holding it
 * (`fits`) — and whether it can be used now, or why not.
 */
export type WayView = { method: string; holder: HeldBy; fits: boolean; availability: Availability };

/**
 * An installed type, and every way it can be added here: where it can run
 * follows from them — a way the master holds, or one this node holds for it;
 * a type with no real way that fits this node needs another.
 */
export type DeviceTypeListing = DeviceTypeView & {
  /** The platform it is on, and whether it is a product on it or the platform's own (docs/PLAN-INTEGRATIONS.md §1). */
  source: TypeSource;
  /** Where each of its real ways can be held: the platforms, and what the node must be — wherever this home runs. */
  placements: Placement[];
  /** Each way it can be added here, in its type's order: the master's, then this node's for the master. */
  ways: WayView[];
  warnings: readonly string[];
};

export type Refused = { source: string; problems: string[] };

/** `GET /api/device-types`. */
export type DeviceTypeList = {
  categories: Record<string, CategorySpec>;
  /** The installed integrations, each a platform its types are on: the types name theirs (`source`). */
  integrations: IntegrationInfo[];
  /** Products first within each platform, its own types after: the order they are offered in. */
  types: DeviceTypeListing[];
  transports: TransportDefinition[];
  refused: { types: Refused[]; protocols: Refused[]; transports: Refused[] };
};

/**
 * `PATCH /devices/:id/attributes`: only what should change, of the attributes
 * its description says can be written. A dangerous one needs `confirmation`: the
 * token the refusal's `needsConfirmation` handed out, once a person said yes. The
 * answer is the gateway's verdict either way, with what the device reports
 * afterwards.
 */
export type AttributeWrite = { patch: Record<string, Value>; confirmation?: string };

/** `POST /devices/:id/parts/:part/commands/:capability/:command`. */
export type CommandBody = { args: Record<string, Value>; reason?: string; confirmation?: string };

/**
 * `POST /devices/:id/tools/:name`, for a tool that writes. One that says what
 * it cannot undo is refused first with 409 `{ error, needsConfirmation }`: the
 * token for a person's yes, presented here as `confirmation`.
 */
export type ToolBody = { input?: Record<string, Value>; confirmation?: string };

export type SeriesPoint = { at: string; value: number };

export type DeviceHistory = {
  deviceId: string;
  key: string;
  from: string;
  to: string;
  /** Minute samples for a short span; hourly means, kept for two years, for a long one. */
  resolution: 'minute' | 'hour';
  points: SeriesPoint[];
};

/** One change of an on/off or an enum: from this moment, it was this. */
export type DeviceChange = { key: string; part: string; at: string; value: Value };

/**
 * `GET /devices/:id/changes?from&to&key`: every change in the span, oldest
 * first, with each key's value from before it began — so "off 14:02–14:19"
 * can be drawn from the first row on.
 */
export type DeviceChanges = { deviceId: string; from: string; to: string; changes: DeviceChange[] };

/** A fact about the house between two parts: this plug's relay feeds that station's mains input. */
export type LinkRecord = { id: LinkId; kind: LinkKind; source: LinkEnd<SavedDeviceId>; target: LinkEnd<SavedDeviceId>; createdAt: string };

/** `POST /links`. */
export type NewLink = { kind: LinkKind; source: LinkEnd<string>; target: LinkEnd<string> };

/** A span of history asked for: `from` and `to`, or the last `hours` up to now, or the last day. */
export type HistoryQuery = { key: string; hours?: number; from?: string; to?: string; points?: number };

/** A span of changes asked for, of one key or all. */
export type ChangesQuery = { key?: string; hours?: number; from?: string; to?: string };
