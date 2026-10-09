import { useMemo } from 'react';

import { NO_WORLD, worldOptionsOf, type ModeView, type PersonView, type WorldOptions, type ZoneView } from '@kraftverk/api-client';

import { useAnswer } from '../../../components/useAnswer';
import { useFamily } from '../../../state/FamilyProvider';
import { useHomeSpaces } from '../../../state/useHomeSpaces';

/*
  The family's world, as the automation editor offers it: read once — its
  people, zones and modes beside the homes and their rooms the app keeps —
  and shaped by api-client's world choices (world-choices.ts).
*/

/** The family's people, places and modes, read once for the editor; null until read. */
export function useWorldOptions(): WorldOptions | null {
  const { api } = useFamily();
  const { homes } = useHomeSpaces();
  const read = useAnswer(() => Promise.all([api.people.list(), api.zones.list(), api.modes.list()]), [api]);
  return useMemo(() => {
    if (!read.value || !homes) return read.error ? NO_WORLD : null;
    const [people, zones, modes] = read.value as [PersonView[], ZoneView[], ModeView[]];
    return worldOptionsOf(people, zones, modes, homes);
  }, [read.value, read.error, homes]);
}
