import { useEffect, useState } from 'react';

import { useFamily } from './FamilyProvider';

type Place = { latitude: number; longitude: number };

/** Asked once per home it is asked of, and shared: every card that says "At home" reads the same answer. */
const asked = new WeakMap<object, Promise<Place | null>>();

/**
 * Where the family's first home is, when it has been said (App settings):
 * what a device's position is told against — "At home", "2.3 km away". Null
 * until known, and when it never was. Until devices stand in homes
 * (docs/PLAN-WORLD-MODEL-WORK.md, W2), the first home is the one.
 */
export function useHomePlace(): Place | null {
  const { api } = useFamily();
  const [place, setPlace] = useState<Place | null>(null);
  useEffect(() => {
    let current = true;
    let pending = asked.get(api);
    if (!pending) {
      pending = api.homes
        .list()
        .then(([first]) => (first?.location ? { latitude: first.location.latitude, longitude: first.location.longitude } : null))
        .catch(() => null);
      asked.set(api, pending);
    }
    void pending.then((found) => current && setPlace(found));
    return () => {
      current = false;
    };
  }, [api]);
  return place;
}
