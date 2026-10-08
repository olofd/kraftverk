import { isPosition, REAL_CLOCK, type Clock, type ClockTimer } from '@kraftverk/device-sdk';
import type { LiveBus } from '@kraftverk/holder';
import type { DevicePeopleStore, PeopleStore, PlaceStore, PresenceStore } from '@kraftverk/store';

import type { DeviceViews } from '../devices/views.ts';
import { decide, freshest, type Fix, type Geofence } from './rules.ts';

/*
  Presence, kept (docs/PLAN-WORLD-MODEL.md §8.9): each member's stays at the
  family's homes and zones, opened and closed by the rules (rules.ts) from
  the freshest position of what they carry — looked at often on the home's
  clock, and at once when a device someone carries says where it is. Each
  person's stays are kept as long as they say. Never on the timeline.
*/

/** How often everyone is looked at: a leave waits out its minutes without a new position. */
const LOOK_EVERY_MS = 15_000;
/** How often old stays are let go. */
const PRUNE_EVERY_MS = 60 * 60_000;

export type PresenceDeps = {
  people: PeopleStore;
  devicePeople: DevicePeopleStore;
  places: PlaceStore;
  stays: PresenceStore;
  views: Pick<DeviceViews, 'find'>;
  bus: Pick<LiveBus, 'subscribe' | 'publish'>;
  clock?: Clock;
};

export class Presence {
  readonly #deps: PresenceDeps;
  readonly #clock: Clock;
  /** Per person, per place still open: when positions first said they were out of it. */
  readonly #outside = new Map<string, Map<string, number>>();
  #timer: ClockTimer | null = null;
  #pruneTimer: ClockTimer | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(deps: PresenceDeps) {
    this.#deps = deps;
    this.#clock = deps.clock ?? REAL_CLOCK;
  }

  start(): void {
    this.#timer ??= this.#clock.setInterval(() => this.look(), LOOK_EVERY_MS);
    this.#pruneTimer ??= this.#clock.setInterval(() => this.prune(), PRUNE_EVERY_MS);
    // A carried device that says where it is: its person looked at now.
    this.#unsubscribe ??= this.#deps.bus.subscribe((message) => {
      if (message.kind !== 'readings' || !message.readings.some((reading) => isPosition(reading.value))) return;
      const carrier = this.#deps.devicePeople.of(message.deviceId).carries;
      if (carrier) this.lookAt(carrier);
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

  /** Every member looked at. */
  look(now = this.#clock.now()): void {
    const places = this.#places();
    for (const person of this.#deps.people.members()) this.lookAt(person.id, now, places);
  }

  /** One person looked at: their stays opened and closed as their freshest position, and what they share, say. */
  lookAt(personId: string, now = this.#clock.now(), places = this.#places()): void {
    const { people, devicePeople, stays, views } = this.#deps;
    const level = people.get(personId)?.member ? people.sharing(personId, new Date(now).toISOString()).now : 'off';
    const fixes: Fix[] = [];
    for (const deviceId of devicePeople.carriedBy(personId)) {
      const device = views.find(deviceId as never);
      const reading = device?.readings.find((each) => isPosition(each.value));
      if (!reading || !isPosition(reading.value) || !reading.at) continue;
      fixes.push({ deviceId, latitude: reading.value.latitude, longitude: reading.value.longitude, accuracy: reading.value.accuracy ?? null, at: Date.parse(reading.at) });
    }
    const open = stays.open(personId).map((stay) => ({ id: stay.id, placeId: stay.placeId, kind: stay.kind, since: Date.parse(stay.since) }));
    const decision = decide({ open, fix: freshest(fixes, now), places, outsideSince: this.#outside.get(personId) ?? new Map(), level, now });
    const kinds = new Map(open.map((stay) => [stay.id, stay]));
    for (const { stayId, until } of decision.end) {
      stays.end(stayId, new Date(until).toISOString());
      const stay = kinds.get(stayId);
      if (stay) this.#deps.bus.publish({ kind: 'presence', personId, place: { id: stay.placeId, kind: stay.kind }, change: 'left', at: new Date(now).toISOString() });
    }
    for (const { place, since, deviceId } of decision.begin) {
      stays.begin(personId, place, new Date(since).toISOString(), deviceId);
      this.#deps.bus.publish({ kind: 'presence', personId, place: { id: place.id, kind: place.kind }, change: 'arrived', at: new Date(now).toISOString() });
    }
    this.#outside.set(personId, decision.outsideSince);
  }

  /** Each person's ended stays kept no longer than they say. */
  prune(now = this.#clock.now()): void {
    for (const person of this.#deps.people.members()) {
      const days = this.#deps.people.sharing(person.id).keepDays;
      this.#deps.stays.prune(person.id, new Date(now - days * 86_400_000).toISOString());
    }
  }

  /** The family's homes that say where they are, and its zones: what a stay can be at. */
  #places(): Geofence[] {
    const { places } = this.#deps;
    return [
      ...places.homes().flatMap((home) => (home.location ? [{ id: home.id, kind: 'home' as const, ...home.location }] : [])),
      ...places.zones().map((zone) => ({ id: zone.id, kind: 'zone' as const, ...zone.location })),
    ];
  }
}
