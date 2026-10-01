import { useCallback, useMemo } from 'react';
import { useFocusEffect } from 'expo-router';

import type { ShownThing } from '@kraftverk/api-contract';

import { useDevices } from './DevicesProvider';

/**
 * Says what this part of the screen shows, for as long as its screen is the
 * one in front: a page under another in the stack shows nothing to anyone.
 * The server judges what follows (`views.ts`): a device shown is read more
 * often while someone looks.
 */
export function useShowing(things: readonly ShownThing[]): void {
  const { views } = useDevices();
  // The same things in a new array are the same: said again only when they change.
  const key = things.map((thing) => `${thing.kind}:${thing.id}`).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => things, [key]);
  useFocusEffect(useCallback(() => views.show(stable), [stable, views]));
}
