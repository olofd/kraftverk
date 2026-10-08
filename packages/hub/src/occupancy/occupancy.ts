import type { DeviceView } from '@kraftverk/api-contract';
import { isCurrent, REAL_CLOCK, type AttributeSpec, type Clock, type ClockTimer, type SavedDeviceId } from '@kraftverk/device-sdk';
import type { LiveBus } from '@kraftverk/holder';
import type { HistoryStore, OccupancyStore, PlaceStore, SpaceStore } from '@kraftverk/store';

import { occupancy, type RoomStay, type Sense, type SensorState } from './rules.ts';

/*
  Occupancy, kept (docs/PLAN-WORLD-MODEL.md §8.9): whether each space of each
  home has someone in it, from what stands there — worked out by the rules
  (rules.ts) at once when such a sensor says something, and often on the
  home's clock, so a hold runs out without a reading. Each change is said
  on the bus, for automations and the app. Kept 30 days.
*/

/** How often every home is looked at: a motion hold runs out, a sensor goes quiet. */
const LOOK_EVERY_MS = 15_000;
/** How often what ended long ago is let go. */
const PRUNE_EVERY_MS = 60 * 60_000;
/** How long occupancy is kept. */
export const OCCUPANCY_DAYS = 30;
/** How far back a sensor's last rise is looked for: a closed room is judged by it. */
const ROSE_WITHIN_MS = 24 * 3_600_000;

/** The meanings that say someone is there, and what each senses. */
const SENSES: Readonly<Record<string, Sense>> = { motion: 'motion', occupied: 'occupied', open: 'open', people: 'people' };

export type OccupancyDeps = {
  places: Pick<PlaceStore, 'homes'>;
  spaces: Pick<SpaceStore, 'spaces' | 'openings' | 'placement'>;
  store: OccupancyStore;
  views: { all(): DeviceView[]; find(id: SavedDeviceId): DeviceView | null };
  history: Pick<HistoryStore, 'changes'>;
  bus: Pick<LiveBus, 'subscribe' | 'publish'>;
  /** Who is in which room of a home, by a signal that tells people apart. */
  roomStays?: (homeId: string) => RoomStay[];
  clock?: Clock;
};

export class Occupancy {
  readonly #deps: OccupancyDeps;
  readonly #clock: Clock;
  #timer: ClockTimer | null = null;
  #pruneTimer: ClockTimer | null = null;
  #unsubscribe: (() => void) | null = null;
  /** The devices that sense someone, with the attributes they sense it by: what a reading is looked at for. */
  #sensing = new Set<string>();
  /** When each sensor was last seen to turn true, by device and key: what history has not kept yet. */
  readonly #rose = new Map<string, number>();
  /** A look asked for and not yet taken: several readings at once are one look. */
  #asked = false;

  constructor(deps: OccupancyDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? REAL_CLOCK;
  }

  start(): void {
    this.#timer ??= this.#clock.setInterval(() => this.look(), LOOK_EVERY_MS);
    this.#pruneTimer ??= this.#clock.setInterval(() => this.prune(), PRUNE_EVERY_MS);
    // A sensor that says something — one new too — a device placed, someone in a room: looked at now.
    this.#unsubscribe ??= this.#deps.bus.subscribe((message) => {
      if (message.kind === 'readings' && (this.#sensing.has(message.deviceId) || this.#senses(message.deviceId))) this.#soon();
      else if (message.kind === 'changed' || (message.kind === 'presence' && message.place.kind === 'space')) this.#soon();
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

  /** Whether a device says anything that tells someone is there. */
  #senses(deviceId: SavedDeviceId): boolean {
    return this.#deps.views.find(deviceId)?.description.attributes.some((attribute) => typeof attribute.means === 'string' && Object.hasOwn(SENSES, attribute.means)) ?? false;
  }

  /** Every home looked at: occupancy opened and closed as what stands there says. */
  look(now = this.#clock.now()): void {
    const views = this.#deps.views.all();
    const sensing = new Set<string>();
    for (const home of this.#deps.places.homes()) {
      const sensors = this.#sensorsOf(home.id, views, now);
      for (const sensor of sensors) sensing.add(sensor.deviceId);
      this.#lookAt(home.id, sensors, now);
    }
    this.#sensing = sensing;
  }

  #lookAt(homeId: string, sensors: SensorState[], now: number): void {
    const { spaces, store, bus } = this.#deps;
    const tree = spaces.spaces(homeId);
    const found = occupancy({ spaces: tree, openings: spaces.openings(homeId), sensors, stays: this.#deps.roomStays?.(homeId) ?? [], now });
    const at = new Date(now).toISOString();
    const open = new Map(store.open(homeId).map((record) => [record.spaceId, record]));
    for (const [spaceId, record] of open) {
      if (found.has(spaceId)) continue;
      store.end(record.id, at);
      bus.publish({ kind: 'occupancy', homeId, spaceId, occupied: false, at });
    }
    for (const [spaceId, occupied] of found) {
      const had = open.get(spaceId);
      if (had) {
        if (occupied.devices.some((device) => !had.devices.includes(device)) || (occupied.peak ?? 0) > (had.peak ?? 0)) store.extend(had.id, occupied.devices, occupied.peak);
        continue;
      }
      store.begin(spaceId, at, occupied.devices, occupied.peak);
      bus.publish({ kind: 'occupancy', homeId, spaceId, occupied: true, at });
    }
  }

  /** What stands in a home and senses someone: each reading as the rules take it. */
  #sensorsOf(homeId: string, views: readonly DeviceView[], now: number): SensorState[] {
    const sensors: SensorState[] = [];
    for (const view of views) {
      const attributes = view.description.attributes.filter((attribute): attribute is AttributeSpec & { means: string } => typeof attribute.means === 'string' && Object.hasOwn(SENSES, attribute.means));
      for (const attribute of attributes) {
        const part = attribute.part ?? 'main';
        // A part placed apart stands where it is placed; the rest where the device does.
        const placed = (part !== 'main' ? this.#deps.spaces.placement(view.id, part) : null) ?? view.placement;
        if (!placed || placed.homeId !== homeId) continue;
        const reading = view.readings.find((each) => each.key === attribute.key);
        if (!reading) continue;
        const value = typeof reading.value === 'boolean' || typeof reading.value === 'number' ? reading.value : null;
        const sense = SENSES[attribute.means]!;
        sensors.push({
          deviceId: view.id,
          sense,
          spaceId: placed.spaceId,
          openingId: placed.openingId,
          value,
          at: Date.parse(reading.at),
          current: isCurrent(attribute, reading, now),
          roseAt: sense === 'motion' || sense === 'occupied' ? this.#roseAt(view.id, attribute.key, value, Date.parse(reading.at), now) : null,
        });
      }
    }
    return sensors;
  }

  /** When a sensor last turned true: as history kept its changes, or as it was seen to here — the later. */
  #roseAt(deviceId: SavedDeviceId, key: string, value: boolean | number | null, at: number, now: number): number | null {
    const id = `${deviceId} ${key}`;
    if (value === true && !(this.#rose.get(id)! >= at)) this.#rose.set(id, at);
    const changes = this.#deps.history.changes(deviceId, { from: new Date(now - ROSE_WITHIN_MS).toISOString(), to: new Date(now).toISOString(), key });
    const kept = changes.filter((change) => change.value === 1).at(-1);
    const seen = this.#rose.get(id);
    const rose = Math.max(kept ? Date.parse(kept.at) : -Infinity, seen ?? -Infinity);
    return Number.isFinite(rose) ? rose : null;
  }

  /** What ended more than 30 days ago, let go. */
  prune(now = this.#clock.now()): void {
    this.#deps.store.prune(new Date(now - OCCUPANCY_DAYS * 86_400_000).toISOString());
  }
}
