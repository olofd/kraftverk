import type { Actor, SavedDeviceId } from '@kraftverk/device-sdk';
import type { OpeningInput, OpeningView, PlacementInput, PlacementView, SpaceInput, SpaceView } from '@kraftverk/api-contract';
import { KEY, keyFrom, newId } from '@kraftverk/device-sdk';

import type { SqlDatabase } from './database.ts';

/**
 * A home's spaces, the openings between them, and where each device stands
 * (docs/PLAN-WORLD-MODEL.md §8.5, §8.7). A home's spaces are a tree, its root
 * the home's site; a space or an opening history points at is archived,
 * never deleted. Where a device stands is an interval: placing it closes
 * the one it had and opens the next, in one transaction, so a reading is
 * the room's it stood in when it was read.
 */

type SpaceRow = {
  id: string;
  home_id: string;
  parent_id: string | null;
  key: string;
  kind: SpaceView['kind'];
  purpose: SpaceView['purpose'];
  name: string;
  icon: string | null;
  picture_id: string | null;
  position: number;
  level: number | null;
  elevation: number | null;
  height: number | null;
  created_at: string;
  removed_at: string | null;
};

const spaceOf = (row: SpaceRow): SpaceView => ({
  id: row.id,
  homeId: row.home_id,
  parentId: row.parent_id,
  key: row.key,
  kind: row.kind,
  purpose: row.purpose,
  name: row.name,
  icon: row.icon,
  pictureId: row.picture_id,
  position: row.position,
  level: row.level,
  elevation: row.elevation,
  height: row.height,
  createdAt: row.created_at,
  removedAt: row.removed_at,
});

type OpeningRow = { id: string; home_id: string; key: string; from_id: string; to_id: string | null; kind: OpeningView['kind']; name: string | null; removed_at: string | null };

const openingOf = (row: OpeningRow): OpeningView => ({ id: row.id, homeId: row.home_id, key: row.key, fromId: row.from_id, toId: row.to_id, kind: row.kind, name: row.name, removedAt: row.removed_at });

type PlacementRow = {
  part: string;
  home_id: string;
  space_id: string;
  opening_id: string | null;
  x: number | null;
  y: number | null;
  z: number | null;
  facing: number | null;
  role: PlacementView['role'];
  since: string;
  until: string | null;
};

const placementOf = (row: PlacementRow): PlacementView => ({
  part: row.part,
  homeId: row.home_id,
  spaceId: row.space_id,
  openingId: row.opening_id,
  x: row.x,
  y: row.y,
  z: row.z,
  facing: row.facing,
  role: row.role,
  since: row.since,
  until: row.until,
});

const PLACEMENT_SELECT = 'SELECT p.part, s.home_id, p.space_id, p.opening_id, p.x, p.y, p.z, p.facing, p.role, p.since, p.until FROM placement p JOIN space s ON s.id = p.space_id';

export class SpaceStore {
  readonly #db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.#db = db;
  }

  // --- spaces ----------------------------------------------------------------------

  /** A home's spaces, its site first, each after its parent, in their order; with those archived, `removed`. */
  spaces(homeId: string, options: { removed?: boolean } = {}): SpaceView[] {
    const rows = this.#db
      .query<SpaceRow, [string]>(`SELECT * FROM space WHERE home_id = ? ${options.removed ? '' : 'AND removed_at IS NULL'} ORDER BY position, created_at`)
      .all(homeId)
      .map(spaceOf);
    // Each after its parent: the tree, read top down.
    const ordered: SpaceView[] = [];
    const visit = (parent: string | null) => {
      for (const space of rows.filter((each) => each.parentId === parent)) {
        ordered.push(space);
        visit(space.id);
      }
    };
    visit(null);
    return ordered;
  }

  space(id: string): SpaceView | null {
    const row = this.#db.query<SpaceRow, [string]>('SELECT * FROM space WHERE id = ?').get(id);
    return row ? spaceOf(row) : null;
  }

  /** A home's site: the root of its spaces, made with it. */
  site(homeId: string): SpaceView {
    const row = this.#db.query<SpaceRow, [string]>("SELECT * FROM space WHERE home_id = ? AND kind = 'site'").get(homeId);
    if (row) return spaceOf(row);
    const id = newId('s');
    this.#db.query("INSERT INTO space (id, home_id, parent_id, key, kind, name, created_at) VALUES (?, ?, NULL, 'site', 'site', 'The site', ?)").run(id, homeId, new Date().toISOString());
    return this.space(id)!;
  }

  /** A space a home has, by its key. */
  spaceByKey(homeId: string, key: string): SpaceView | null {
    const row = this.#db.query<SpaceRow, [string, string]>('SELECT * FROM space WHERE home_id = ? AND key = ? AND removed_at IS NULL').get(homeId, key);
    return row ? spaceOf(row) : null;
  }

  spaceKeyTaken(homeId: string, key: string, except?: string): boolean {
    return this.#db.query<{ id: string }, [string, string]>('SELECT id FROM space WHERE home_id = ? AND key = ? AND removed_at IS NULL').all(homeId, key).some((row) => row.id !== except);
  }

  /** A space made under its parent, in its parent's home: after its siblings unless placed. */
  addSpace(input: SpaceInput): SpaceView {
    const parent = this.space(input.parentId);
    if (!parent || parent.removedAt) throw new Error('No such space to put it in');
    if (input.key !== undefined && (!KEY.test(input.key) || this.spaceKeyTaken(parent.homeId, input.key))) throw new Error(`"${input.key}" is not a free key in this home`);
    const key = input.key ?? keyFrom(input.name, (taken) => taken === 'site' || this.spaceKeyTaken(parent.homeId, taken), 'space');
    const position = input.position ?? this.#db.query<{ next: number }, [string]>('SELECT coalesce(max(position) + 1, 0) AS next FROM space WHERE parent_id = ?').get(parent.id)!.next;
    const id = newId('s');
    this.#db
      .query(
        `INSERT INTO space (id, home_id, parent_id, key, kind, purpose, name, icon, picture_id, position, level, elevation, height, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        parent.homeId,
        parent.id,
        key,
        input.kind,
        input.purpose ?? null,
        input.name,
        input.icon ?? null,
        input.pictureId ?? null,
        position,
        input.kind === 'floor' ? (input.level ?? 0) : null,
        input.kind === 'floor' ? (input.elevation ?? null) : null,
        input.height ?? null,
        new Date().toISOString()
      );
    return this.space(id)!;
  }

  /** A space changed: what is given, the rest as it was — moved under another parent of the same home, too. */
  updateSpace(id: string, changes: Partial<SpaceInput>): SpaceView | null {
    const was = this.space(id);
    if (!was || was.kind === 'site') return was;
    if (changes.key !== undefined && changes.key !== was.key && (!KEY.test(changes.key) || changes.key === 'site' || this.spaceKeyTaken(was.homeId, changes.key, id))) throw new Error(`"${changes.key}" is not a free key in this home`);
    if (changes.parentId !== undefined && changes.parentId !== was.parentId && this.#within(changes.parentId, id)) throw new Error('A space cannot be put inside itself');
    const next = { ...was, ...changes } as SpaceView & Partial<SpaceInput>;
    this.#db
      .query('UPDATE space SET parent_id = ?, key = ?, kind = ?, purpose = ?, name = ?, icon = ?, picture_id = ?, position = ?, level = ?, elevation = ?, height = ? WHERE id = ?')
      .run(
        next.parentId,
        next.key,
        next.kind,
        next.purpose,
        next.name,
        next.icon,
        next.pictureId,
        next.position,
        next.kind === 'floor' ? (next.level ?? 0) : null,
        next.kind === 'floor' ? next.elevation : null,
        next.height,
        id
      );
    return this.space(id);
  }

  /** Whether `candidate` is `id` or inside it. */
  #within(candidate: string, id: string): boolean {
    for (let at: SpaceView | null = this.space(candidate); at; at = at.parentId ? this.space(at.parentId) : null) if (at.id === id) return true;
    return false;
  }

  /**
   * A space archived, with every space inside it and every opening of
   * theirs: what stood there is history. What stands there now is moved to
   * the space it was in. Never the site.
   */
  archiveSpace(id: string, by: Actor): SpaceView | null {
    const was = this.space(id);
    if (!was || was.kind === 'site' || was.removedAt) return was;
    const at = new Date().toISOString();
    const gone = [id, ...this.spaces(was.homeId).filter((space) => space.id !== id && this.#within(space.id, id)).map((space) => space.id)];
    this.#db.transaction(() => {
      for (const space of gone) {
        for (const placed of this.#db.query<{ device_id: string; part: string }, [string]>('SELECT device_id, part FROM placement WHERE space_id = ? AND until IS NULL').all(space))
          this.place(placed.device_id as SavedDeviceId, { spaceId: was.parentId!, part: placed.part }, by, at);
        this.#db.query('UPDATE opening SET removed_at = ? WHERE (from_id = ? OR to_id = ?) AND removed_at IS NULL').run(at, space, space);
        this.#db.query('UPDATE space SET removed_at = ? WHERE id = ?').run(at, space);
      }
    })();
    return this.space(id);
  }

  // --- openings ----------------------------------------------------------------------

  openings(homeId: string, options: { removed?: boolean } = {}): OpeningView[] {
    return this.#db
      .query<OpeningRow, [string]>(`SELECT * FROM opening WHERE home_id = ? ${options.removed ? '' : 'AND removed_at IS NULL'} ORDER BY created_at`)
      .all(homeId)
      .map(openingOf);
  }

  opening(id: string): OpeningView | null {
    const row = this.#db.query<OpeningRow, [string]>('SELECT * FROM opening WHERE id = ?').get(id);
    return row ? openingOf(row) : null;
  }

  openingByKey(homeId: string, key: string): OpeningView | null {
    const row = this.#db.query<OpeningRow, [string, string]>('SELECT * FROM opening WHERE home_id = ? AND key = ? AND removed_at IS NULL').get(homeId, key);
    return row ? openingOf(row) : null;
  }

  openingKeyTaken(homeId: string, key: string, except?: string): boolean {
    return this.#db.query<{ id: string }, [string, string]>('SELECT id FROM opening WHERE home_id = ? AND key = ? AND removed_at IS NULL').all(homeId, key).some((row) => row.id !== except);
  }

  /** An opening made, from a space to another of the same home or to the outside. */
  addOpening(input: OpeningInput): OpeningView {
    const from = this.space(input.fromId);
    if (!from || from.removedAt) throw new Error('No such space');
    if (input.key !== undefined && (!KEY.test(input.key) || this.openingKeyTaken(from.homeId, input.key))) throw new Error(`"${input.key}" is not a free key in this home`);
    const key = input.key ?? keyFrom(input.name ?? `${from.name} ${input.kind}`, (taken) => this.openingKeyTaken(from.homeId, taken), 'opening');
    const id = newId('o');
    this.#db
      .query('INSERT INTO opening (id, home_id, key, from_id, to_id, kind, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, from.homeId, key, input.fromId, input.toId, input.kind, input.name ?? null, new Date().toISOString());
    return this.opening(id)!;
  }

  updateOpening(id: string, changes: Partial<OpeningInput>): OpeningView | null {
    const was = this.opening(id);
    if (!was) return null;
    if (changes.key !== undefined && changes.key !== was.key && (!KEY.test(changes.key) || this.openingKeyTaken(was.homeId, changes.key, id))) throw new Error(`"${changes.key}" is not a free key in this home`);
    const next = { ...was, ...changes };
    this.#db.query('UPDATE opening SET key = ?, from_id = ?, to_id = ?, kind = ?, name = ? WHERE id = ?').run(next.key, next.fromId, next.toId, next.kind, next.name ?? null, id);
    return this.opening(id);
  }

  archiveOpening(id: string): OpeningView | null {
    this.#db.query('UPDATE opening SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(new Date().toISOString(), id);
    return this.opening(id);
  }

  // --- where devices stand ----------------------------------------------------------------------

  /** Where a device stands now, each part placed apart: none, when it is not placed. */
  placement(deviceId: SavedDeviceId, part = 'main'): PlacementView | null {
    const row = this.#db.query<PlacementRow, [string, string]>(`${PLACEMENT_SELECT} WHERE p.device_id = ? AND p.part = ? AND p.until IS NULL`).get(deviceId, part);
    return row ? placementOf(row) : null;
  }

  /** Where every device stands now, by device: its main part's. */
  placements(): Map<string, PlacementView> {
    const rows = this.#db.query<PlacementRow & { device_id: string }, []>(`${PLACEMENT_SELECT.replace('SELECT ', 'SELECT p.device_id, ')} WHERE p.until IS NULL AND p.part = 'main'`).all();
    return new Map(rows.map((row) => [row.device_id, placementOf(row)]));
  }

  /** Where a device has stood, oldest first. */
  history(deviceId: SavedDeviceId, part = 'main'): PlacementView[] {
    return this.#db.query<PlacementRow, [string, string]>(`${PLACEMENT_SELECT} WHERE p.device_id = ? AND p.part = ? ORDER BY p.since`).all(deviceId, part).map(placementOf);
  }

  /** Every device that stood in a space between two times, and when: what a room's readings are asked by. */
  stoodIn(spaceId: string, from: string, to: string): { deviceId: SavedDeviceId; part: string; since: string; until: string | null }[] {
    return this.#db
      .query<{ device_id: string; part: string; since: string; until: string | null }, [string, string, string]>(
        'SELECT device_id, part, since, until FROM placement WHERE space_id = ? AND since < ? AND (until IS NULL OR until > ?) ORDER BY since'
      )
      .all(spaceId, to, from)
      .map((row) => ({ deviceId: row.device_id as SavedDeviceId, part: row.part, since: row.since, until: row.until }));
  }

  /**
   * A device placed — in a space, perhaps at an opening, perhaps at
   * coordinates — from `at` on: the placement it had closed, and this one
   * opened, in one transaction. Placed where it already is, as it is: nothing
   * changes.
   */
  place(deviceId: SavedDeviceId, input: PlacementInput, by: Actor, at = new Date().toISOString()): PlacementView {
    const part = input.part ?? 'main';
    const space = this.space(input.spaceId);
    if (!space || space.removedAt) throw new Error('No such space');
    if (input.openingId) {
      const opening = this.opening(input.openingId);
      if (!opening || opening.removedAt || (opening.fromId !== space.id && opening.toId !== space.id)) throw new Error('That opening is not one of that space');
    }
    const now = this.placement(deviceId, part);
    const same =
      now &&
      now.spaceId === input.spaceId &&
      now.openingId === (input.openingId ?? null) &&
      now.x === (input.x ?? null) &&
      now.y === (input.y ?? null) &&
      now.z === (input.z ?? null) &&
      now.facing === (input.facing ?? null) &&
      now.role === (input.role ?? 'stands');
    if (same) return now;
    this.#db.transaction(() => {
      // Closed where it was, a moment before it stands here: never two at once.
      const closedAt = now && now.since >= at ? new Date(Date.parse(now.since) + 1).toISOString() : at;
      this.#db.query('UPDATE placement SET until = ? WHERE device_id = ? AND part = ? AND until IS NULL').run(closedAt, deviceId, part);
      this.#db
        .query(
          `INSERT INTO placement (id, device_id, part, space_id, opening_id, x, y, z, facing, role, since, until, actor_kind, actor_id, actor_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`
        )
        .run(newId('pl'), deviceId, part, input.spaceId, input.openingId ?? null, input.x ?? null, input.y ?? null, input.z ?? null, input.facing ?? null, input.role ?? 'stands', closedAt, by.kind, by.id, by.name);
    })();
    return this.placement(deviceId, part)!;
  }

  /** A device no longer placed anywhere: its placement closed, its history kept. */
  unplace(deviceId: SavedDeviceId, part = 'main', at = new Date().toISOString()): void {
    const now = this.placement(deviceId, part);
    if (!now) return;
    // Ended after it began, whenever that was: an interval is never empty.
    const until = now.since >= at ? new Date(Date.parse(now.since) + 1).toISOString() : at;
    this.#db.query('UPDATE placement SET until = ? WHERE device_id = ? AND part = ? AND until IS NULL').run(until, deviceId, part);
  }
}
