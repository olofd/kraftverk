import { useCallback, useState } from 'react';

import { describeError } from '@kraftverk/api-client';

/**
 * Something a person asked for, tried: busy while it runs, and why it did not
 * work when it fails — the home's words, or `failure` when it gave none.
 * `attempt` says whether it worked.
 */
export function useAttempt() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useCallback(async (work: () => Promise<unknown>, failure: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (caught) {
      setError(describeError(caught) || failure);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, setBusy, error, setError, attempt };
}
