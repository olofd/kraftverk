import { useCallback, useEffect, useState } from 'react';

import { describeError, type AutomationView } from '@kraftverk/api-client';
import { savedDeviceId } from '@kraftverk/device-sdk';

import { useHome } from '../../state/HomeProvider';
import { useReadAgain } from './useReadAgain';

/**
 * Automations as a screen lists them — all of them, or those a device fills
 * a role of — read, read again when they may have changed (`useReadAgain`),
 * and one a card changed put in its place. Nothing is read while `when` is
 * false.
 */
export function useAutomations({ device, followReadings = false, when = true }: { device?: string; followReadings?: boolean; when?: boolean } = {}) {
  const { api } = useHome();
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!when) return;
    api.automations.list(device ? { device: savedDeviceId(device) } : {}).then(
      (all) => (setAutomations(all), setError(null)),
      (err: unknown) => setError(describeError(err) || 'The automations could not be read')
    );
  }, [api, device, when]);
  useEffect(load, [load]);
  useReadAgain(load, { followReadings });
  /** One changed on its card, put in its place. */
  const replace = useCallback((next: AutomationView) => setAutomations((all) => all?.map((candidate) => (candidate.id === next.id ? next : candidate)) ?? null), []);
  return { automations, error, replace };
}
