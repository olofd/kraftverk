import { useCallback, useEffect, useState } from 'react';

import type { AutomationView } from '@kraftverk/api-client';
import { savedDeviceId } from '@kraftverk/device-sdk';

import { useHome } from '../../state/HomeProvider';
import { AutomationList } from './AutomationList';
import { useReadAgain } from './useReadAgain';

/**
 * The automations a device takes part in, at the bottom of its page — the
 * same list, and the same cards, as the automations screen, kept to this
 * device: run or stopped from here, opened to their own page, and a new one
 * made from here (docs/AUTOMATIONS-UX.md).
 */
export function DeviceAutomations({ device }: { device: { id: string; name: string } }) {
  const { api } = useHome();
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);

  const load = useCallback(() => {
    api.automations
      .list({ device: savedDeviceId(device.id) })
      .then(setAutomations)
      .catch(() => undefined);
  }, [api, device.id]);

  useEffect(() => load(), [load]);
  // Its runs move on the live stream: read again when one does, or now and then while the stream is down.
  useReadAgain(load, { followReadings: false });

  if (!automations) return null;
  const replace = (next: AutomationView) => setAutomations((all) => all?.map((candidate) => (candidate.id === next.id ? next : candidate)) ?? null);
  return <AutomationList automations={automations} onChanged={replace} title="Automations" device={device} empty={`No automation uses ${device.name} yet.`} />;
}
