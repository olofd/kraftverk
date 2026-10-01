import { useCallback, useEffect, useState } from 'react';
import { YStack } from 'tamagui';

import { fetchAutomations, type AutomationView } from '@kraftverk/api-client';
import { SectionLabel } from '@kraftverk/ui';

import { useAuth } from '../../state/AuthProvider';
import { useDevices } from '../../state/DevicesProvider';
import { AutomationCard } from './AutomationCard';
import { useReadAgain } from './useReadAgain';

/**
 * The automations put on the home page (docs/AUTOMATION-EDITOR.md), in their
 * places: each the same card as in the list of automations — run it, or stop
 * it, and see how it stands; its name opens its page. Nothing when none is there, or no server runs
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
      {shortcuts.map((automation) => (
        <AutomationCard key={automation.id} automation={automation} onChanged={replace} />
      ))}
    </YStack>
  );
}
