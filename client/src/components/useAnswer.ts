import { useEffect, useState, type DependencyList } from 'react';

import { describeError } from '@kraftverk/api-client';

/**
 * What a screen reads from the home: read when it opens and again whenever
 * `deps` change — with `every`, also every so often — keeping the latest
 * answer, and why it could not be read (the home's words, or `failure`). An
 * answer that comes after the screen stopped wanting it is not heard; while
 * `when` is false nothing is read, and the last answer stays.
 */
export function useAnswer<T>(read: () => Promise<T>, deps: DependencyList, options: { failure?: string; every?: number; when?: boolean } = {}): { value: T | null; error: string | null } {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { failure = 'It could not be read', every, when = true } = options;
  useEffect(() => {
    if (!when) return;
    let live = true;
    const load = () =>
      read().then(
        (answer) => {
          if (!live) return;
          setValue(answer);
          setError(null);
        },
        (caught: unknown) => live && setError(describeError(caught) || failure)
      );
    void load();
    const timer = every ? setInterval(() => void load(), every) : null;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [...deps, when]);
  return { value, error };
}
