import { useCallback, useEffect, useState } from 'react';

import type { KraftverkApi, Labelled, LabelView } from '@kraftverk/api-client';

import { useFamily } from './FamilyProvider';

type Labels = { labels: LabelView[]; labelled: Labelled };

/** Each family's answer, shared by every screen that asks it — and those listening, told when it is read again. */
const kept = new WeakMap<object, { answer: Promise<Labels>; listeners: Set<(labels: Labels) => void> }>();

const NONE: Labels = { labels: [], labelled: { devices: {}, spaces: {}, automations: {} } };
const read = (api: KraftverkApi): Promise<Labels> => Promise.all([api.labels.list(), api.labels.labelled()]).then(([labels, labelled]) => ({ labels, labelled }));

/**
 * The family's labels, and what each is on (docs/PLAN-WORLD-MODEL.md §8.13):
 * what the home screen filters by, and a device's settings offer. Null until
 * read. `reload` after a change reads it again for every screen showing it.
 */
export function useLabels(): { labels: Labels | null; reload: () => Promise<void> } {
  const { api } = useFamily();
  const [labels, setLabels] = useState<Labels | null>(null);
  useEffect(() => {
    let entry = kept.get(api);
    if (!entry) {
      entry = { answer: read(api).catch(() => (kept.delete(api), NONE)), listeners: new Set() };
      kept.set(api, entry);
    }
    let current = true;
    const listener = (fresh: Labels) => current && setLabels(fresh);
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
    if (entry) entry.answer = answer.catch(() => NONE);
    const fresh = await answer;
    for (const listener of entry?.listeners ?? []) listener(fresh);
  }, [api]);
  return { labels, reload };
}
