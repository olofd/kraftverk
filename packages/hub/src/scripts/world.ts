import { capabilitiesOf, partsOf } from '@kraftverk/device-sdk';
import type { ScriptHome } from '@kraftverk/script';

import type { Hub } from '../node/hub.ts';

/*
  The family's world as its scripts see it (docs/PLAN-SCRIPTS.md §6): its
  people, its homes with their rooms, its modes and its devices — each in
  the order a script's names are given by (names.ts), so the editor's types
  (`scripts.types()`) and a running script (runner.ts) call each thing the
  same. Never where anything is: a position is not a script's to read.
*/

/** A device as a script sees it: its key, name and parts, each with what it can do. */
export function scriptDevice(hub: Hub, id: string) {
  const record = hub.catalog.active(id as never);
  if (!record) return null;
  const description = hub.sessions.description(record);
  return { id: record.id, key: record.key, name: record.name, type: record.typeId, parts: partsOf(description, record.name).map((part) => ({ id: part.id, label: part.label, capabilities: capabilitiesOf(description, part.id) })) };
}

/** The family's people, by id: who a script names. */
export const scriptPeople = (hub: Hub): { id: string; name: string }[] => hub.world.members().map((id) => ({ id, name: hub.world.personName(id) ?? id }));

/** The family's homes, each with its rooms: every space but its ground. */
export const scriptHomes = (hub: Hub): { id: string; key: string; name: string; rooms: { id: string; key: string; name: string }[] }[] =>
  hub.places.homes().map((home) => ({
    id: home.id,
    key: home.key,
    name: home.name,
    rooms: hub.spaces
      .spaces(home.id)
      .filter((space) => space.kind !== 'site')
      .map((space) => ({ id: space.id, key: space.key, name: space.name })),
  }));

/** Everything a script's types are made from: the world, and each device with what it reports. */
export function scriptHome(hub: Hub): ScriptHome {
  const devices = hub.catalog.list().flatMap((record) => {
    if (record.removedAt) return [];
    const description = hub.sessions.description(record);
    return [
      {
        key: record.key,
        name: record.name,
        type: record.typeId,
        parts: partsOf(description, record.name).map((part) => ({ id: part.id, label: part.label, capabilities: capabilitiesOf(description, part.id) })),
        readings: description.attributes.filter((attribute) => attribute.quantity !== 'position').map((attribute) => ({ key: attribute.key, label: attribute.label, value: attribute.value })),
      },
    ];
  });
  return {
    devices,
    people: scriptPeople(hub).map((person) => ({ name: person.name })),
    homes: scriptHomes(hub).map((home) => ({ key: home.key, name: home.name, rooms: home.rooms.map((room) => ({ key: room.key, name: room.name })) })),
    modes: hub.world.modes().map((mode) => ({ key: mode.key, axis: mode.axis, name: mode.name })),
  };
}
