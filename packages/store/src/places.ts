import type { HomeInput, HomeType, ZoneInput } from '@kraftverk/api-contract';
import { KEY, keyFrom, newId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * The places the family names (docs/PLAN-WORLD-MODEL.md §8.4): its homes —
 * a house, a cabin — each a place on the globe with its own clock, and the
 * zones it knows, which come with presence. A place history points at is
 * archived, never deleted: moving house is a new home.
 */

export const HOME_TYPES = ['house', 'apartment', 'cabin', 'boat', 'caravan', 'office', 'other'] as const satisfies readonly HomeType[];

/** Where a place is, and its geofence: a circle of so many metres round it. */
export type PlaceLocation = { latitude: number; longitude: number; radius: number };

/** An address, as written: each part optional. */
export type Address = { street: string | null; postalCode: string | null; locality: string | null; region: string | null };

export type HomeRecord = {
  id: string;
  /** Its name in configuration: what a file and an import know it by. */
  key: string;
  name: string;
  type: HomeType;
  icon: string | null;
  /** A photo of it, by its media id; null: none. */
  pictureId: string | null;
  /** Null: its people have not said where it is. */
  location: PlaceLocation | null;
  /** IANA: what its clocks keep. */
  timeZone: string;
  address: Address;
  /** ISO 3166-1 alpha-2, when said. */
  country: string | null;
  /** Degrees from north to its y axis: where its floor plans sit on the globe. */
  bearing: number;
  /** Its order among the family's homes. */
  position: number;
  createdAt: string;
  /** Archived: left, or moved from. Null while it is the family's. */
  removedAt: string | null;
};

/** A zone: a place the family knows that is no home — school, work — where presence says someone is. Always somewhere. */
export type ZoneRecord = {
  id: string;
  key: string;
  name: string;
  icon: string | null;
  location: PlaceLocation;
  createdAt: string;
  /** Archived: what was recorded there stays its own. Null while the family knows it. */
  removedAt: string | null;
};

type ZoneRow = { id: string; key: string; name: string; icon: string | null; latitude: number; longitude: number; radius: number; created_at: string; removed_at: string | null };

const zoneOf = (row: ZoneRow): ZoneRecord => ({
  id: row.id,
  key: row.key,
  name: row.name,
  icon: row.icon,
  location: { latitude: row.latitude, longitude: row.longitude, radius: row.radius },
  createdAt: row.created_at,
  removedAt: row.removed_at,
});

/** How big a zone's geofence is when nobody said: a school, a workplace. */
export const ZONE_RADIUS = 200;

type Row = {
  id: string;
  key: string;
  name: string;
  icon: string | null;
  latitude: number | null;
  longitude: number | null;
  radius: number | null;
  time_zone: string;
  street: string | null;
  postal_code: string | null;
  locality: string | null;
  region: string | null;
  country: string | null;
  created_at: string;
  removed_at: string | null;
  type: HomeType;
  picture_id: string | null;
  bearing: number;
  position: number;
};

const HOME_SELECT = 'SELECT p.*, h.type, h.picture_id, h.bearing, h.position FROM place p JOIN home h ON h.id = p.id';

/** How big a geofence is when nobody said: a house and its garden. */
export const HOME_RADIUS = 150;

const toRecord = (row: Row): HomeRecord => ({
  id: row.id,
  key: row.key,
  name: row.name,
  type: row.type,
  icon: row.icon,
  pictureId: row.picture_id,
  location: row.latitude !== null && row.longitude !== null ? { latitude: row.latitude, longitude: row.longitude, radius: row.radius ?? HOME_RADIUS } : null,
  timeZone: row.time_zone,
  address: { street: row.street, postalCode: row.postal_code, locality: row.locality, region: row.region },
  country: row.country,
  bearing: row.bearing,
  position: row.position,
  createdAt: row.created_at,
  removedAt: row.removed_at,
});

const NO_ADDRESS: Address = { street: null, postalCode: null, locality: null, region: null };

export class PlaceStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  /** The family's homes, in their order: the ones it has, or with those it left. */
  homes(options: { removed?: boolean } = {}): HomeRecord[] {
    return this.#db
      .query<Row, []>(`${HOME_SELECT} ${options.removed ? '' : 'WHERE p.removed_at IS NULL'} ORDER BY h.position, p.created_at`)
      .all()
      .map(toRecord);
  }

  /** One home, left or not. */
  home(id: string): HomeRecord | null {
    const row = this.#db.query<Row, [string]>(`${HOME_SELECT} WHERE p.id = ?`).get(id);
    return row ? toRecord(row) : null;
  }

  /** A home the family has, by its key. */
  homeByKey(key: string): HomeRecord | null {
    const row = this.#db.query<Row, [string]>(`${HOME_SELECT} WHERE p.key = ? AND p.removed_at IS NULL`).get(key);
    return row ? toRecord(row) : null;
  }

  /** Whether a home the family has holds a key: one other than `except`. */
  homeKeyTaken(key: string, except?: string): boolean {
    return this.#db.query<{ id: string }, [string]>("SELECT id FROM place WHERE kind = 'home' AND key = ? AND removed_at IS NULL").all(key).some((row) => row.id !== except);
  }

  /** The family's first home: what the family's own clock and place are, until devices and automations say whose they are. */
  first(): HomeRecord | null {
    return this.homes()[0] ?? null;
  }

  /** A home added, after the others. */
  addHome(input: HomeInput, id = newId('h')): HomeRecord {
    if (input.key !== undefined && (!KEY.test(input.key) || this.homeKeyTaken(input.key))) throw new Error(`"${input.key}" is not a free key: lowercase letters, digits and dashes, and not another home's`);
    const key = input.key ?? keyFrom(input.name, (taken) => this.homeKeyTaken(taken), 'home');
    const position = this.#db.query<{ next: number }, []>('SELECT coalesce(max(position) + 1, 0) AS next FROM home').get()!.next;
    this.#db.transaction(() => {
      this.#writePlace(id, { ...input, key }, new Date().toISOString(), null);
      this.#db.query('INSERT INTO home (id, type, picture_id, bearing, position) VALUES (?, ?, ?, ?, ?)').run(id, input.type, input.pictureId ?? null, input.bearing ?? 0, position);
      // Its site: the root of its spaces, where what stands "in the home, room not said" stands.
      this.#db.query("INSERT INTO space (id, home_id, parent_id, key, kind, name, created_at) VALUES (?, ?, NULL, 'site', 'site', 'The site', ?)").run(newId('s'), id, new Date().toISOString());
    })();
    return this.home(id)!;
  }

  /** A home changed: what is given, the rest as it was. */
  updateHome(id: string, changes: Partial<HomeInput>): HomeRecord | null {
    const was = this.home(id);
    if (!was) return null;
    if (changes.key !== undefined && changes.key !== was.key && (!KEY.test(changes.key) || this.homeKeyTaken(changes.key, id))) throw new Error(`"${changes.key}" is not a free key: lowercase letters, digits and dashes, and not another home's`);
    const next = { ...was, ...changes };
    this.#db.transaction(() => {
      this.#db
        .query(
          `UPDATE place SET key = ?, name = ?, icon = ?, latitude = ?, longitude = ?, radius = ?, time_zone = ?, street = ?, postal_code = ?, locality = ?, region = ?, country = ?
           WHERE id = ?`
        )
        .run(
          next.key,
          next.name,
          next.icon,
          next.location?.latitude ?? null,
          next.location?.longitude ?? null,
          next.location?.radius ?? null,
          next.timeZone,
          next.address.street,
          next.address.postalCode,
          next.address.locality,
          next.address.region,
          next.country,
          id
        );
      this.#db.query('UPDATE home SET type = ?, picture_id = ?, bearing = ? WHERE id = ?').run(next.type, next.pictureId, next.bearing, id);
    })();
    return this.home(id);
  }

  /** A home the family left, archived: what was recorded there stays its own. */
  archiveHome(id: string): HomeRecord | null {
    this.#db.query("UPDATE place SET removed_at = ? WHERE id = ? AND kind = 'home' AND removed_at IS NULL").run(new Date().toISOString(), id);
    return this.home(id);
  }

  /** The family's homes as its master's database has them, kept in a node that follows it: added, changed, and those it no longer has gone. */
  mirrorHomes(homes: readonly HomeRecord[]): void {
    this.#db.transaction(() => {
      for (const home of homes) {
        if (this.home(home.id)) this.updateHome(home.id, home);
        else {
          this.#writePlace(home.id, home, home.createdAt, home.removedAt);
          this.#db.query('INSERT INTO home (id, type, picture_id, bearing, position) VALUES (?, ?, ?, ?, ?)').run(home.id, home.type, home.pictureId, home.bearing, home.position);
        }
        this.#db.query('UPDATE home SET position = ? WHERE id = ?').run(home.position, home.id);
        this.#db.query('UPDATE place SET removed_at = ? WHERE id = ?').run(home.removedAt, home.id);
      }
    })();
  }

  // --- zones -----------------------------------------------------------------------

  /** The zones the family knows, by name; with those it let go, `removed`. */
  zones(options: { removed?: boolean } = {}): ZoneRecord[] {
    return this.#db
      .query<ZoneRow, []>(`SELECT * FROM place WHERE kind = 'zone' ${options.removed ? '' : 'AND removed_at IS NULL'} ORDER BY name COLLATE NOCASE, created_at`)
      .all()
      .map(zoneOf);
  }

  zone(id: string): ZoneRecord | null {
    const row = this.#db.query<ZoneRow, [string]>("SELECT * FROM place WHERE kind = 'zone' AND id = ?").get(id);
    return row ? zoneOf(row) : null;
  }

  /** A zone the family knows, by its key. */
  zoneByKey(key: string): ZoneRecord | null {
    const row = this.#db.query<ZoneRow, [string]>("SELECT * FROM place WHERE kind = 'zone' AND key = ? AND removed_at IS NULL").get(key);
    return row ? zoneOf(row) : null;
  }

  zoneKeyTaken(key: string, except?: string): boolean {
    return this.#db.query<{ id: string }, [string]>("SELECT id FROM place WHERE kind = 'zone' AND key = ? AND removed_at IS NULL").all(key).some((row) => row.id !== except);
  }

  addZone(input: ZoneInput, id = newId('z')): ZoneRecord {
    if (input.key !== undefined && (!KEY.test(input.key) || this.zoneKeyTaken(input.key))) throw new Error(`"${input.key}" is not a free key: lowercase letters, digits and dashes, and not another zone's`);
    const key = input.key ?? keyFrom(input.name, (taken) => this.zoneKeyTaken(taken), 'zone');
    this.#writePlace(id, { key, name: input.name, icon: input.icon ?? null, location: input.location, timeZone: null }, new Date().toISOString(), null, 'zone');
    return this.zone(id)!;
  }

  updateZone(id: string, changes: Partial<ZoneInput>): ZoneRecord | null {
    const was = this.zone(id);
    if (!was) return null;
    if (changes.key !== undefined && changes.key !== was.key && (!KEY.test(changes.key) || this.zoneKeyTaken(changes.key, id))) throw new Error(`"${changes.key}" is not a free key: lowercase letters, digits and dashes, and not another zone's`);
    const next = { ...was, ...changes };
    this.#db
      .query('UPDATE place SET key = ?, name = ?, icon = ?, latitude = ?, longitude = ?, radius = ? WHERE id = ? AND kind = \'zone\'')
      .run(next.key, next.name, next.icon ?? null, next.location.latitude, next.location.longitude, next.location.radius, id);
    return this.zone(id);
  }

  /** A zone let go, archived: the stays there stay its own. */
  archiveZone(id: string): ZoneRecord | null {
    this.#db.query("UPDATE place SET removed_at = ? WHERE id = ? AND kind = 'zone' AND removed_at IS NULL").run(new Date().toISOString(), id);
    return this.zone(id);
  }

  #writePlace(
    id: string,
    input: Pick<HomeInput, 'name' | 'icon' | 'location' | 'address' | 'country'> & { key: string; timeZone: string | null },
    createdAt: string,
    removedAt: string | null,
    kind: 'home' | 'zone' = 'home'
  ): void {
    const address = input.address ?? NO_ADDRESS;
    this.#db
      .query(
        `INSERT INTO place (id, kind, key, name, icon, latitude, longitude, radius, time_zone, street, postal_code, locality, region, country, created_at, removed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        kind,
        input.key,
        input.name,
        input.icon ?? null,
        input.location?.latitude ?? null,
        input.location?.longitude ?? null,
        input.location?.radius ?? null,
        input.timeZone,
        address.street,
        address.postalCode,
        address.locality,
        address.region,
        input.country ?? null,
        createdAt,
        removedAt
      );
  }
}
