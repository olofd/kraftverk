/*
  A family's homes, as it answers them (docs/PLAN-WORLD-MODEL.md §8.4): a
  house, a cabin — each a place on the globe, with its own clock. Moving
  house is a new home; the one left is archived, and what was recorded
  there stays its own.
*/

export type HomeType = 'house' | 'apartment' | 'cabin' | 'boat' | 'caravan' | 'office' | 'other';

/** Where a home is, and its geofence: a circle of so many metres round it. */
export type HomeLocation = { latitude: number; longitude: number; radius: number };

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
