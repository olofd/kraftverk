import type { DeviceView } from '@kraftverk/api-contract';
import { isCurrent, REAL_CLOCK, type AttributeSpec, type Clock, type ClockTimer, type Reading } from '@kraftverk/device-sdk';
import type { LiveBus } from '@kraftverk/holder';
import type { HistoryStore, OccupancyStore, PlaceStore, SpaceStore } from '@kraftverk/store';

import { MOTION_HOLD_MS, occupancy, type RoomStay, type Sense, type SensorState } from './rules.ts';

/*
  Occupancy, kept (docs/PLAN-WORLD-MODEL.md §8.9): whether each space of each
  home has someone in it, from what stands there — worked out by the rules
  (rules.ts) when a sensor's value changes, and when a hold runs out. Each
  change is said on the bus, for automations and the app. Kept 30 days.

  When each sensor's value changed is kept here, as the bus says it — and,
  for what changed before it listened, as history kept it: a device's time
  is when it last spoke, not when its value changed. As it starts, what it
  hears is what was kept, not what is so: for the length of a hold nothing
  is ended, only begun.
*/

/** The longest a home goes unlooked at: a sensor gone quiet stops counting within it. */
const LOOK_AT_LEAST_EVERY_MS = 60_000;
/** How often what ended long ago is let go. */
const PRUNE_EVERY_MS = 60 * 60_000;
/** How long occupancy is kept. */
export const OCCUPANCY_DAYS = 30;
/** How far back a sensor's last change is looked for in history. */
const CHANGED_WITHIN_MS = 24 * 3_600_000;
/** After starting, how long nothing is ended: until every sensor has had its say. */
const WARM_UP_MS = MOTION_HOLD_MS;

/** The meanings that say someone is there, and what each senses. */
const SENSES: Readonly<Record<string, Sense>> = { motion: 'motion', occupied: 'occupied', open: 'open', people: 'people' };

/** When a sensor's value last changed, and when it last turned true. */
type Edge = { value: boolean | number | null; since: number | null; roseAt: number | null };

/** What a sensed value is: someone there or not, a door open or not — or how many. */
type Kind = 'boolean' | 'number';

export type OccupancyDeps = {
  places: Pick<PlaceStore, 'homes'>;
  spaces: Pick<SpaceStore, 'spaces' | 'openings' | 'placement'>;
  store: OccupancyStore;
  views: { all(): DeviceView[] };
  history: Pick<HistoryStore, 'changes'>;
  bus: Pick<LiveBus, 'subscribe' | 'publish'>;
  /** Who is in which room of a home, by a signal that tells people apart — as far as each shares. */
  roomStays?: (homeId: string) => RoomStay[];
  clock?: Clock;
};

const scalar = (value: Reading['value']): boolean | number | null => (typeof value === 'boolean' || typeof value === 'number' ? value : null);

export class Occupancy {
  readonly #deps: OccupancyDeps;
  readonly #clock: Clock;
  #timer: ClockTimer | null = null;
  #pruneTimer: ClockTimer | null = null;
  #unsubscribe: (() => void) | null = null;
  #startedAt = 0;
  /** The keys each sensing device senses by, and whether each is an on/off or a count: what a reading is looked at for. Made again as devices change. */
  #sensed = new Map<string, Map<string, Kind>>();
  /** When each sensor's value changed, by device and key. */
  readonly #edges = new Map<string, Edge>();
  /** A look asked for and not yet taken: several readings at once are one look. */
  #asked = false;

  constructor(deps: OccupancyDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? REAL_CLOCK;
  }

  start(): void {
    this.#startedAt = this.#clock.now();
    this.#pruneTimer ??= this.#clock.setInterval(() => this.prune(), PRUNE_EVERY_MS);
    // A sensed value that moved, a device changed or placed, someone in a room: looked at now.
    this.#unsubscribe ??= this.#deps.bus.subscribe((message) => {
      if (message.kind === 'readings') {
        const keys = this.#sensed.get(message.deviceId);
        if (!keys) return;
        let moved = false;
        for (const reading of message.readings) {
          const kind = keys.get(reading.key);
          if (kind && this.#heard(message.deviceId, reading, kind)) moved = true;
        }
        if (moved) this.#soon();
      } else if (message.kind === 'changed' || message.kind === 'described' || (message.kind === 'presence' && message.place.kind === 'space')) this.#soon();
    });
    this.look();
  }

  stop(): void {
    this.#clock.clear(this.#timer);
    this.#clock.clear(this.#pruneTimer);
    this.#unsubscribe?.();
    this.#timer = null;
    this.#pruneTimer = null;
    this.#unsubscribe = null;
  }

  /** A look in a moment, once for everything said meanwhile. */
  #soon(): void {
    if (this.#asked) return;
    this.#asked = true;
    queueMicrotask(() => {
      this.#asked = false;
      this.look();
    });
  }

  /** A sensed reading heard: its change kept. Whether its value moved. */
  #heard(deviceId: string, reading: Reading, kind: Kind): boolean {
    const id = `${deviceId} ${reading.key}`;
    const value = scalar(reading.value);
    const edge = this.#edges.get(id) ?? this.#kept(deviceId, reading.key, kind, this.#clock.now());
    if (edge.value === value) {
      this.#edges.set(id, edge);
      return false;
    }
    const at = Date.parse(reading.at);
    this.#edges.set(id, { value, since: at, roseAt: value === true ? at : edge.roseAt });
    return true;
  }

  /** A sensor's last change, as history kept it: what was so before this listened. */
  #kept(deviceId: string, key: string, kind: Kind, now: number): Edge {
    const changes = this.#deps.history.changes(deviceId, { from: new Date(now - CHANGED_WITHIN_MS).toISOString(), to: new Date(now).toISOString(), key });
    // History keeps an on/off as 1 or 0.
    const valueOf = (kept: number | null) => (kept === null ? null : kind === 'boolean' ? kept === 1 : kept);
    const last = changes.at(-1);
    const rose = kind === 'boolean' ? changes.filter((change) => change.value === 1).at(-1) : undefined;
    return { value: last ? valueOf(last.value) : null, since: last ? Date.parse(last.at) : null, roseAt: rose ? Date.parse(rose.at) : null };
  }

  /** Every home looked at: occupancy opened and closed as what stands there says; the next look set for when a hold runs out. */
  look(now = this.#clock.now()): void {
    const views = this.#deps.views.all();
    const sensed = new Map<string, Map<string, Kind>>();
    const warming = now - this.#startedAt < WARM_UP_MS;
    let next = now + LOOK_AT_LEAST_EVERY_MS;
    const homes = this.#deps.places.homes();
    for (const home of homes) {
      const sensors = this.#sensorsOf(home.id, views, sensed, now);
      const found = this.#lookAt(home.id, sensors, now, warming);
      if (found !== null) next = Math.min(next, found);
    }
    if (warming) next = Math.min(next, this.#startedAt + WARM_UP_MS);
    // A home archived, or gone: nobody is in it any more, as far as anything here says.
    const live = new Set(homes.map((home) => home.id));
    const at = new Date(now).toISOString();
    for (const record of this.#deps.store.allOpen()) {
      if (live.has(record.homeId)) continue;
      this.#deps.store.end(record.id, at);
      this.#deps.bus.publish({ kind: 'occupancy', homeId: record.homeId, spaceId: record.spaceId, occupied: false, at });
    }
    this.#sensed = sensed;
    this.#again(next, now);
  }

  /** One home: what changed, said. When its answer next changes on the clock alone, if it does. */
  #lookAt(homeId: string, sensors: SensorState[], now: number, warming: boolean): number | null {
    const { spaces, store, bus } = this.#deps;
    const { occupied, next } = occupancy({ spaces: spaces.spaces(homeId), openings: spaces.openings(homeId), sensors, stays: this.#deps.roomStays?.(homeId) ?? [], now });
    const at = new Date(now).toISOString();
    const open = new Map(store.open(homeId).map((record) => [record.spaceId, record]));
    for (const [spaceId, record] of open) {
      // As it starts, what it hears is what was kept: nothing ends until every sensor has had its say.
      if (occupied.has(spaceId) || warming) continue;
      store.end(record.id, at);
      bus.publish({ kind: 'occupancy', homeId, spaceId, occupied: false, at });
    }
    for (const [spaceId, found] of occupied) {
      const had = open.get(spaceId);
      if (had) {
        if (found.devices.some((device) => !had.devices.includes(device)) || (found.peak ?? 0) > (had.peak ?? 0)) store.extend(had.id, found.devices, found.peak);
        continue;
      }
      store.begin(spaceId, at, found.devices, found.peak);
      bus.publish({ kind: 'occupancy', homeId, spaceId, occupied: true, at });
    }
    return next;
  }

  /** What stands in a home and senses someone: each reading as the rules take it. The keys each senses by, noted. */
  #sensorsOf(homeId: string, views: readonly DeviceView[], sensed: Map<string, Map<string, Kind>>, now: number): SensorState[] {
    const sensors: SensorState[] = [];
    for (const view of views) {
      const attributes = view.description.attributes.filter((attribute): attribute is AttributeSpec & { means: string } => typeof attribute.means === 'string' && Object.hasOwn(SENSES, attribute.means));
      if (!attributes.length) continue;
      const kinds = new Map(attributes.map((attribute): [string, Kind] => [attribute.key, attribute.value.type === 'number' ? 'number' : 'boolean']));
      sensed.set(view.id, kinds);
      for (const attribute of attributes) {
        const part = attribute.part ?? 'main';
        // A part placed apart stands where it is placed; the rest where the device does.
        const placed = (part !== 'main' ? this.#deps.spaces.placement(view.id, part) : null) ?? view.placement;
        if (!placed || placed.homeId !== homeId) continue;
        const reading = view.readings.find((each) => each.key === attribute.key);
        if (!reading) continue;
        const value = scalar(reading.value);
        const id = `${view.id} ${attribute.key}`;
        const edge = this.#edges.get(id) ?? this.#kept(view.id, attribute.key, kinds.get(attribute.key)!, now);
        // What history kept, or what was heard, is what it says now: else when it changed was not seen.
        const known = edge.value === value ? edge : { value, since: null, roseAt: edge.roseAt };
        this.#edges.set(id, known);
        const placedAt = Date.parse(placed.since);
        sensors.push({
          deviceId: view.id,
          sense: SENSES[attribute.means]!,
          spaceId: placed.spaceId,
          openingId: placed.openingId,
          value,
          current: isCurrent(attribute, reading, now),
          since: known.since,
          heard: Math.max(Date.parse(reading.at), reading.confirmedAt ? Date.parse(reading.confirmedAt) : 0),
          // A rise before it stood here was in another room.
          roseAt: known.roseAt !== null && !(known.roseAt < placedAt) ? known.roseAt : null,
        });
      }
    }
    return sensors;
  }

  /** The next look, at a time on the home's clock. */
  #again(at: number, now: number): void {
    if (!this.#unsubscribe) return;
    this.#clock.clear(this.#timer);
    this.#timer = this.#clock.setTimeout(() => this.look(), Math.max(0, at - now) + 5);
  }

  /** What ended more than 30 days ago, let go. */
  prune(now = this.#clock.now()): void {
    this.#deps.store.prune(new Date(now - OCCUPANCY_DAYS * 86_400_000).toISOString());
  }
}
