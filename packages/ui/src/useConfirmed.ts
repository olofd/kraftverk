import { useCallback, useEffect, useState } from 'react';

/** How long what a device confirmed is shown over what it reported before. */
const CONFIRMED_MS = 10_000;

type Kept = { value: unknown; until: number };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a device confirmed a write set, shown until it reports it too.
 *
 * A write's pending value goes as the write ends (`useWriteGate`); what the
 * screen holds of the device's readings may be older still — readings come
 * a moment apart, and every few seconds while the live stream is down. So a
 * switch turned off and confirmed would show on again until the next reading:
 * off, on, off. What was confirmed is shown instead, until a reading says the
 * same or `CONFIRMED_MS` pass — then the readings, whatever they say.
 */
export function useConfirmed() {
  const [kept, setKept] = useState<ReadonlyMap<string, Kept>>(new Map());

  // Let go of each as its time is up, so the readings show again by themselves.
  useEffect(() => {
    if (!kept.size) return;
    const next = Math.min(...[...kept.values()].map((entry) => entry.until));
    const timer = setTimeout(() => setKept((current) => new Map([...current].filter(([, entry]) => entry.until > Date.now()))), Math.max(0, next - Date.now()));
    return () => clearTimeout(timer);
  }, [kept]);

  /** These keys were confirmed set to these values. */
  const keep = useCallback((values: Readonly<Record<string, unknown>>) => {
    setKept((current) => {
      const next = new Map(current);
      for (const [key, value] of Object.entries(values)) next.set(key, { value, until: Date.now() + CONFIRMED_MS });
      return next;
    });
  }, []);

  /** What to show for a key: what was confirmed, while it is kept — else what the device reports. */
  const shown = useCallback(
    <T>(key: string, reported: T): T => {
      const entry = kept.get(key);
      return entry && entry.until > Date.now() && !same(entry.value, reported) ? (entry.value as T) : reported;
    },
    [kept]
  );

  return { keep, shown };
}
