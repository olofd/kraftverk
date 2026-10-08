import { ApiError, type Caller, type KraftverkApi, type ZoneInput, type ZoneView } from '@kraftverk/api-contract';
import { KEY } from '@kraftverk/device-sdk';
import { ZONE_RADIUS, type ZoneRecord } from '@kraftverk/store';

import type { Hub } from '../node/hub.ts';
import { actorOf } from './caller.ts';

/*
  A family's zones, as it answers them (docs/PLAN-WORLD-MODEL.md §8.4): the
  places it knows that are no home — school, work — each a circle on the
  map, where presence says someone is. Added, changed, and archived when let
  go. On the timeline by name, never its coordinates.
*/

const zoneView = (zone: ZoneRecord): ZoneView => ({ ...zone });

/** What a zone given says, checked: a refusal names what is wrong, in words. */
function checked(input: Partial<ZoneInput>): void {
  if (input.name !== undefined && !(input.name.trim().length >= 1 && input.name.trim().length <= 60)) throw new ApiError('invalid', 'A zone’s name is 1 to 60 characters');
  const at = input.location;
  if (at && !(Math.abs(at.latitude) <= 90 && Math.abs(at.longitude) <= 180)) throw new ApiError('invalid', 'A latitude is from -90 to 90, a longitude from -180 to 180');
  if (at && !(at.radius >= 10 && at.radius <= 50_000)) throw new ApiError('invalid', 'A zone is from 10 m to 50 km across its middle');
}

export function zonesApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'zones'> {
  const actor = actorOf(caller);
  const record = (kind: string, zone: ZoneRecord, summary: string) => hub.audit.record({ at: new Date().toISOString(), kind, actor, resourceKind: 'zone', resource: zone.id, summary });
  const zoneOf = (id: string): ZoneRecord => {
    const zone = hub.places.zone(id);
    if (!zone) throw new ApiError('not-found', 'No such zone');
    return zone;
  };
  const asPerson = () => {
    if (caller.kind === 'agent') throw new ApiError('forbidden', 'An assistant cannot change the family’s zones');
  };
  return {
    zones: {
      list: async (options = {}) => hub.places.zones(options).map(zoneView),

      async add(input) {
        asPerson();
        if (!input.location) throw new ApiError('invalid', 'A zone is somewhere: its latitude, longitude and size');
        checked(input);
        if (input.key !== undefined && (!KEY.test(input.key) || hub.places.zoneKeyTaken(input.key))) throw new ApiError('conflict', `"${input.key}" is not a free key: lowercase letters, digits and dashes, and not another zone's`);
        const zone = hub.places.addZone({ ...input, name: input.name.trim(), location: { ...input.location, radius: input.location.radius ?? ZONE_RADIUS } });
        record('zone.added', zone, `Added the zone "${zone.name}"`);
        return zoneView(zone);
      },

      async update(id, changes) {
        asPerson();
        const was = zoneOf(id);
        checked(changes);
        if (changes.key !== undefined && changes.key !== was.key && (!KEY.test(changes.key) || hub.places.zoneKeyTaken(changes.key, was.id))) throw new ApiError('conflict', `"${changes.key}" is not a free key: lowercase letters, digits and dashes, and not another zone's`);
        const zone = hub.places.updateZone(was.id, { ...changes, ...(changes.name !== undefined ? { name: changes.name.trim() } : {}) })!;
        // Where it is goes on the timeline as changed: never the coordinates.
        const said = Object.keys(changes).map((key) => (key === 'location' ? 'where it is' : key));
        record('zone.changed', zone, `Changed the zone "${zone.name}": ${said.join(', ') || 'nothing'}`);
        return zoneView(zone);
      },

      async remove(id) {
        asPerson();
        const zone = zoneOf(id);
        if (zone.removedAt) return zoneView(zone);
        const gone = hub.places.archiveZone(zone.id)!;
        record('zone.removed', gone, `Let go of the zone "${zone.name}"`);
        return zoneView(gone);
      },
    },
  };
}
