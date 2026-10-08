import { useMemo } from 'react';

import type { WorldKeys } from '@kraftverk/api-client/config';
import { personKeysOf } from '@kraftverk/home-file';

import { useAnswer } from '../../components/useAnswer';
import { useFamily } from '../../state/FamilyProvider';
import { useHomeSpaces } from '../../state/useHomeSpaces';

/** The family's people and places by the keys a file names them by: what an automation's YAML says for who and where. */
export function useWorldKeys(): WorldKeys {
  const { api } = useFamily();
  const { homes } = useHomeSpaces();
  const read = useAnswer(() => Promise.all([api.people.list(), api.zones.list()]), [api]);
  return useMemo(() => {
    const [people, zones] = read.value ?? [[], []];
    // As an export writes them: members with keys of their own, by name, in the order they joined.
    const keys = personKeysOf(people.filter((person) => person.member && person.keys.length));
    return {
      people: [...keys].map(([id, key]) => ({ id, key })),
      places: [
        ...(homes ?? []).map(({ home }) => ({ id: home.id, key: home.key, kind: 'home' as const })),
        ...zones.map((zone) => ({ id: zone.id, key: zone.key, kind: 'zone' as const })),
        ...(homes ?? []).flatMap(({ home, spaces }) => spaces.filter((space) => space.kind !== 'site').map((space) => ({ id: space.id, key: space.key, kind: 'space' as const, homeId: home.id }))),
      ],
    };
  }, [read.value, homes]);
}
