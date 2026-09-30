import { useCallback, useEffect, useState } from 'react';
import { YStack } from 'tamagui';

import { fetchAutomationsFor, type AutomationView } from '@kraftverk/api-client';
import { Card, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { useDevices } from '../../state/DevicesProvider';
import { RunControl } from './RunControl';
import { useReadAgain } from './useReadAgain';

/**
 * The automations a device is part of that you start yourself — "Start
 * charging the scooter" on the scooter's page, and on its plug's — each with
 * Start, or Stop while it runs, following it as it goes (docs/SEQUENCES.md).
 * Nothing when there are none, or no server to run them.
 */
export function DeviceAutomations({ deviceId }: { deviceId: string }) {
  const { mode } = useDevices();
  const [automations, setAutomations] = useState<AutomationView[]>([]);

  const load = useCallback(() => {
    fetchAutomationsFor(deviceId)
      .then((all) => setAutomations(all.filter((automation) => automation.startsWhenAsked && automation.mode !== 'off')))
      .catch(() => undefined);
  }, [deviceId]);

  useEffect(() => {
    if (mode === 'server') load();
  }, [load, mode]);
  // Its runs move on the live stream: read again when one does, or now and then while the stream is down.
  useReadAgain(load, { followReadings: false });

  if (mode !== 'server' || !automations.length) return null;
  const replace = (next: AutomationView) => setAutomations((all) => all.map((candidate) => (candidate.id === next.id ? next : candidate)));
  return (
    <YStack gap="$2">
      <SectionLabel>Start</SectionLabel>
      <Card inset>
        {automations.map((automation, index) => (
          <YStack key={automation.id}>
            {index > 0 ? <RowSeparator /> : null}
            <YStack paddingHorizontal="$4" paddingVertical="$3">
              <RunControl automation={automation} onChanged={replace} compact />
            </YStack>
          </YStack>
        ))}
      </Card>
    </YStack>
  );
}
