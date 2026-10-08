import { useCallback, useEffect, useState } from 'react';

import type { HomeSpaces, KraftverkApi } from '@kraftverk/api-client';

import { useFamily } from './FamilyProvider';

/** Each family's answer, shared by every screen that asks it — and those listening, told when it is read again. */
const kept = new WeakMap<object, { answer: Promise<HomeSpaces[]>; listeners: Set<(homes: HomeSpaces[]) => void> }>();

const read = (api: KraftverkApi): Promise<HomeSpaces[]> =>
  api.homes.list().then((homes) => Promise.all(homes.map(async (home) => ({ home, spaces: await api.spaces.list(home.id), openings: await api.openings.list(home.id) }))));

/**
 * The family's homes, each with its spaces and openings (docs/PLAN-WORLD-MODEL.md
 * §8.5): what the home screen groups devices by, and a device's "where it is"
 * offers. Null until read. `reload` after a change reads it again for every
 * screen showing it.
 */
export function useHomeSpaces(): { homes: HomeSpaces[] | null; reload: () => Promise<void> } {
  const { api } = useFamily();
  const [homes, setHomes] = useState<HomeSpaces[] | null>(null);
  useEffect(() => {
    let entry = kept.get(api);
    if (!entry) {
      entry = { answer: read(api).catch(() => []), listeners: new Set() };
      kept.set(api, entry);
    }
    let current = true;
    const listener = (fresh: HomeSpaces[]) => current && setHomes(fresh);
    entry.listeners.add(listener);
    void entry.answer.then(listener);
    return () => {
      current = false;
      entry.listeners.delete(listener);
    };
  }, [api]);
  const reload = useCallback(async () => {
    const entry = kept.get(api);
    const answer = read(api);
    if (entry) entry.answer = answer.catch(() => []);
    const fresh = await answer;
    for (const listener of entry?.listeners ?? []) listener(fresh);
  }, [api]);
  return { homes, reload };
}
