import type { SeriesPoint } from './devices.ts';

/*
  A family's homes, as it answers them (docs/PLAN-WORLD-MODEL.md §8.4): a
  house, a cabin — each a place on the globe, with its own clock. Moving
  house is a new home; the one left is archived, and what was recorded
  there stays its own.
*/

export type HomeType = 'house' | 'apartment' | 'cabin' | 'boat' | 'caravan' | 'office' | 'other';

/** Where a home is, and its geofence: a circle of so many metres round it. */
export type HomeLocation = { latitude: number; longitude: number; radius: number };

/**
 * A zone (docs/PLAN-WORLD-MODEL.md §8.4): a place the family knows that is no
 * home — school, work, the gym — where presence says someone is. Always
 * somewhere; no clock of its own. Let go, it is archived: the stays there
 * stay its own.
 */
export type ZoneView = {
  id: string;
  /** Its name in configuration. */
  key: string;
  name: string;
  icon: string | null;
  location: HomeLocation;
  createdAt: string;
  /** Archived; null while the family knows it. */
  removedAt: string | null;
};

export type ZoneInput = {
  /** Made from its name when not given. */
  key?: string;
  name: string;
  icon?: string | null;
  location: HomeLocation;
};

/** An address, as written: each part optional. */
export type HomeAddress = { street: string | null; postalCode: string | null; locality: string | null; region: string | null };

export type HomeView = {
  id: string;
  /** Its name in configuration: what a file and an import know it by. */
  key: string;
  name: string;
  type: HomeType;
  icon: string | null;
  /** A photo of it, by its media id (`GET /media/:id`); null: none. */
  pictureId: string | null;
  /** Null: its people have not said where it is. */
  location: HomeLocation | null;
  /** IANA: what its clocks keep. */
  timeZone: string;
  address: HomeAddress;
  /** ISO 3166-1 alpha-2, when said: what Maps offers to download for it. */
  country: string | null;
  /** Degrees from north to its y axis: where its floor plans sit on the globe. */
  bearing: number;
  /** Its order among the family's homes. */
  position: number;
  createdAt: string;
  /** Archived: left, or moved from. Null while it is the family's. */
  removedAt: string | null;
};

/** A home made, or changed: what is given; a location of null says it is not said. */
export type HomeInput = {
  /** Made from its name when not given. */
  key?: string;
  name: string;
  type: HomeType;
  timeZone: string;
  icon?: string | null;
  /** A picture already added (`media.add`), by its id; null takes it away. */
  pictureId?: string | null;
  location?: HomeLocation | null;
  address?: HomeAddress;
  country?: string | null;
  bearing?: number;
};

/*
  A home's spaces, the openings between them, and where a device stands
  (docs/PLAN-WORLD-MODEL.md §8.5, §8.7).
*/

/** A point in a frame: metres along its x axis and its y axis. */
export type FramePoint = readonly [x: number, y: number];

/**
 * A space's own frame (§8.7): where its origin is in its parent's frame, and
 * how far it is turned from it, in degrees clockwise. A room drawn square to
 * its own walls stays square however the house sits.
 */
export type SpaceFrame = { x: number; y: number; turn: number };

/**
 * A floor's drawing, placed in its frame: what rooms are traced over. The
 * picture's top-left corner falls at x, y; each of its pixels is `scale`
 * metres; it is turned `turn` degrees clockwise about that corner.
 */
export type FloorPlanInput = { pictureId: string; scale: number; x: number; y: number; turn: number };

/** A floor's drawing as it is kept: placed, and how many pixels it is across and down. */
export type FloorPlanView = FloorPlanInput & { width: number; height: number };

export type SpaceKind = 'site' | 'building' | 'floor' | 'room' | 'area' | 'stairs' | 'outdoor';
export type SpacePurpose = 'kitchen' | 'living' | 'dining' | 'bedroom' | 'children' | 'guest' | 'bathroom' | 'toilet' | 'hallway' | 'office' | 'laundry' | 'storage' | 'utility' | 'garage' | 'gym' | 'sauna' | 'other';

/** A space of a home: the site at its root, buildings, floors, rooms, areas, stairs, the outdoors. */
export type SpaceView = {
  id: string;
  homeId: string;
  /** Null only for the site: the home's ground. */
  parentId: string | null;
  /** Its name in configuration, within its home. */
  key: string;
  kind: SpaceKind;
  purpose: SpacePurpose | null;
  name: string;
  icon: string | null;
  pictureId: string | null;
  /** Its order among its siblings. */
  position: number;
  /** A floor's: 0 the ground floor. */
  level: number | null;
  /** A floor's: metres above the site's ground. */
  elevation: number | null;
  /** Metres floor to ceiling. */
  height: number | null;
  /** Its own frame within its parent's; null: its parent's. */
  frame: SpaceFrame | null;
  /** Its outline, in its own frame: the corners in order, at least three, the last joined to the first. Null: not drawn. */
  outline: FramePoint[] | null;
  /** A floor's drawing, when it has one. */
  plan: FloorPlanView | null;
  createdAt: string;
  removedAt: string | null;
};

/** A space made: under its parent — the site, a building, a floor, a room. */
export type SpaceInput = {
  parentId: string;
  key?: string;
  kind: Exclude<SpaceKind, 'site'>;
  purpose?: SpacePurpose | null;
  name: string;
  icon?: string | null;
  pictureId?: string | null;
  position?: number;
  level?: number | null;
  elevation?: number | null;
  height?: number | null;
  frame?: SpaceFrame | null;
  outline?: FramePoint[] | null;
  /** A floor's drawing: a picture already added (`media.add`), by its id. Only a floor has one. */
  plan?: FloorPlanInput | null;
};

export type OpeningKind = 'door' | 'opening' | 'stairs' | 'window' | 'gate' | 'garage-door' | 'elevator';

/** Where two spaces meet, or a space meets the outside. */
export type OpeningView = {
  id: string;
  homeId: string;
  key: string;
  fromId: string;
  toId: string | null;
  kind: OpeningKind;
  name: string | null;
  /** Where in the wall it is: a line in its `from` space's frame. Null: not drawn. */
  shape: FramePoint[] | null;
  removedAt: string | null;
};

/** An opening made: from one space, to another or to the outside. */
export type OpeningInput = { key?: string; fromId: string; toId: string | null; kind: OpeningKind; name?: string | null; shape?: FramePoint[] | null };

/** Where a device stands, or is based: since when, in which space of which home, perhaps at an opening, perhaps at coordinates. */
export type PlacementView = {
  part: string;
  homeId: string;
  spaceId: string;
  openingId: string | null;
  /** Metres in the space's frame; null when not said. */
  x: number | null;
  y: number | null;
  z: number | null;
  facing: number | null;
  role: 'stands' | 'based';
  since: string;
  until: string | null;
};

/** A home's two axes of mode (docs/PLAN-WORLD-MODEL.md §8.10): whether anyone is home, and the time of day. */
export type { ModeAxis } from '@kraftverk/device-sdk';
import type { ModeAxis } from '@kraftverk/device-sdk';

/** A mode: built in — home, away, vacation; day, evening, night — or a family's own on either axis, known by its key. */
export type ModeView = { id: string; key: string; axis: ModeAxis; name: string; icon: string | null; builtIn: boolean; removedAt: string | null };

/** A family's own mode, made or changed: its key made from its name when not given. */
export type ModeInput = { key?: string; axis: ModeAxis; name: string; icon?: string | null };

/** A home's mode on one axis: now, since when and who set it — none when never set — and what is set to come. */
/**
 * A home's mode on one axis: since when, set by whom — and what is set to
 * come, each change in order: `planned`, set to begin then, what can be let
 * go; not, what comes back as one planned ends.
 */
export type HomeModeView = { axis: ModeAxis; mode: ModeView | null; since: string | null; by: string | null; ahead: { mode: ModeView; from: string; until: string | null; planned: boolean }[] };

/** A home set to a mode, by its id or key: from now unless said, for good or until a time — the mode before coming back then. */
export type ModeSet = { mode: string; from?: string; until?: string | null };

/**
 * A space with someone in it, whoever they are (docs/PLAN-WORLD-MODEL.md
 * §8.9): since when — and until, once nobody is — what said so, and the
 * most there at once when a sensor counts. A floor, a building or the site
 * is, while a space within it is.
 */
export type OccupancyView = { spaceId: string; since: string; until: string | null; peak: number | null; devices: string[] };

/** A label (docs/PLAN-WORLD-MODEL.md §8.13): any grouping the family wants — "upstairs", "heating" — on devices, spaces and automations. */
export type LabelView = { id: string; key: string; name: string; color: string | null; icon: string | null };

/** A label made, or changed: a colour as "#rrggbb". */
export type LabelInput = { key?: string; name: string; color?: string | null; icon?: string | null };

/** What a label is on: one device, space or automation. */
export type LabelTarget = { device: string } | { space: string } | { automation: string };

/** Which labels are on what: each device, space and automation by id, with its labels' ids. */
export type Labelled = { devices: Record<string, string[]>; spaces: Record<string, string[]>; automations: Record<string, string[]> };

/** `GET /spaces/:id/history?means&hours|from&to&points`: a reading of what it means — `temperature` — in a space and the spaces inside it. */
export type SpaceHistoryQuery = { means: string; hours?: number; from?: string; to?: string; points?: number };

/**
 * What was read in a space, by what stood there, while it stood there: one
 * series for each stay — a device that stood there twice is two, each
 * clipped to its own span — and none for a device that stood elsewhere.
 */
export type SpaceHistory = {
  spaceId: string;
  means: string;
  from: string;
  to: string;
  resolution: 'minute' | 'hour';
  series: { deviceId: string; part: string; key: string; spaceId: string; from: string; to: string; points: SeriesPoint[] }[];
};

/** A device placed: in a space — a home's site when no room is said — perhaps at an opening, perhaps at coordinates. */
export type PlacementInput = { spaceId: string; part?: string; openingId?: string | null; x?: number | null; y?: number | null; z?: number | null; facing?: number | null; role?: 'stands' | 'based' };
