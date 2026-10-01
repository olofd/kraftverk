import { useCallback, useEffect, useState } from 'react';

import { fetchAutomationsFor, type AutomationView } from '@kraftverk/api-client';

import { useDevices } from '../../state/DevicesProvider';
import { AutomationList } from './AutomationList';
import { useReadAgain } from './useReadAgain';

/**
 * The automations a device takes part in, at the bottom of its page — the
 * same list, and the same cards, as the automations screen, kept to this
 * device: run or stopped from here, opened to their own page, and a new one
 * made from here (docs/AUTOMATIONS-UX.md). Nothing when no server runs them.
 */
export function DeviceAutomations({ device }: { device: { id: string; name: string } }) {
  const { mode } = useDevices();
  const [automations, setAutomations] = useState<AutomationView[] | null>(null);

  const load = useCallback(() => {
    fetchAutomationsFor(device.id)
      .then(setAutomations)
      .catch(() => undefined);
  }, [device.id]);

  useEffect(() => {
    if (mode === 'server') load();
  }, [load, mode]);
  // Its runs move on the live stream: read again when one does, or now and then while the stream is down.
  useReadAgain(load, { followReadings: false });

  if (mode !== 'server' || !automations) return null;
  const replace = (next: AutomationView) => setAutomations((all) => all?.map((candidate) => (candidate.id === next.id ? next : candidate)) ?? null);
  return <AutomationList automations={automations} onChanged={replace} title="Automations" device={device} empty={`No automation uses ${device.name} yet.`} />;
}
