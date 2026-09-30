import { useCallback, useEffect, useState } from 'react';
import { YStack } from 'tamagui';

import { fetchAutomations, type AutomationView } from '@kraftverk/api-client';
import { Card, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { useAuth } from '../../state/AuthProvider';
import { useDevices } from '../../state/DevicesProvider';
import { RunControl } from './RunControl';
import { useReadAgain } from './useReadAgain';

/**
 * The automations put on the home page (docs/AUTOMATION-EDITOR.md), in their
 * places: each a tile to start it — or stop it — the step it is in while it
 * runs, and how it last went. Nothing when none is there, or no server runs
 * them.
 */
export function Shortcuts() {
  const { mode } = useDevices();
  const { allowed } = useAuth();
  const [shortcuts, setShortcuts] = useState<AutomationView[]>([]);

  const load = useCallback(() => {
    fetchAutomations()
      .then((all) => setShortcuts(all.filter((automation) => automation.homePlace !== null).sort((a, b) => a.homePlace! - b.homePlace!)))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (mode === 'server' && allowed) load();
  }, [allowed, load, mode]);
  // A run moving — or one put on the page, or taken off — is heard on the live stream.
  useReadAgain(load, { followReadings: false });

  if (mode !== 'server' || !shortcuts.length) return null;
  const replace = (next: AutomationView) => setShortcuts((all) => all.map((candidate) => (candidate.id === next.id ? next : candidate)));
  return (
    <YStack gap="$2">
      <SectionLabel>Shortcuts</SectionLabel>
      <Card inset>
        {shortcuts.map((automation, index) => (
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
