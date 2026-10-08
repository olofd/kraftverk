import type { Caller, DeviceView } from '@kraftverk/api-contract';
import { isPosition, isSpot, type Reading } from '@kraftverk/device-sdk';
import type { DevicePeopleStore, PeopleStore, TrackStore } from '@kraftverk/store';

/*
  What a person shares, enforced where a position could leave
  (docs/PLAN-WORLD-MODEL.md §11.2). A device someone carries says where it is
  only while they share \`precise\`: to every reader but themselves, its
  position is otherwise left out — of its view, its trail, the live stream,
  what an automation reads — and below \`precise\` it is never kept: not as a
  last reading, not as a trail, and the trail it had is let go when they
  share less. The master answers this way, so every node that asks it does.
*/

type Stores = { people: Pick<PeopleStore, 'sharing'>; devicePeople: Pick<DevicePeopleStore, 'of' | 'carriedBy'> };

/** Who asks, by their person id: none for an assistant, or a server's account not yet anyone's. */
export const readerOf = (caller: Caller): string | null => (caller.kind === 'person' ? (caller.id ?? null) : null);

/**
 * Whether a device's position is left out for a reader — null: kept for no
 * one, as storing it or an automation reading it is. Only a device someone
 * carries, below \`precise\`, and not for its carrier.
 */
export function positionHidden(stores: Stores, deviceId: string, reader: string | null): boolean {
  const carrier = stores.devicePeople.of(deviceId).carries;
  if (!carrier || carrier === reader) return false;
  return stores.people.sharing(carrier).now !== 'precise';
}

/** A device's readings, without its position where it is left out — on the Earth, or on a map of a home (a spot): either says where its carrier is. */
export const withoutPosition = <T extends Pick<Reading, 'value'>>(readings: readonly T[]): T[] => readings.filter((reading) => !isPosition(reading.value) && !isSpot(reading.value));

/** A device as a reader may see it. */
export function shownTo(stores: Stores, reader: string | null): (view: DeviceView) => DeviceView {
  return (view) => (positionHidden(stores, view.id, reader) ? { ...view, readings: withoutPosition(view.readings) } : view);
}

/** A person shares less than \`precise\` now: the trails of what they carry are let go, as §11.2 says. */
export function forgetCarriedTrails(stores: Stores & { tracks: Pick<TrackStore, 'forget'> }, personId: string): void {
  if (stores.people.sharing(personId).now === 'precise') return;
  for (const deviceId of stores.devicePeople.carriedBy(personId)) stores.tracks.forget(deviceId);
}
