import { YStack } from 'tamagui';

import { SectionLabel } from '@kraftverk/ui';

import { useAuth } from '../../state/AuthProvider';
import { AutomationCard } from './AutomationCard';
import { useAutomations } from './useAutomations';

/**
 * The automations put on the home page (docs/AUTOMATION-EDITOR.md), in their
 * places: each the same card as in the list of automations — run it, or stop
 * it, and see how it stands; its name opens its page. Nothing when none is there.
 */
export function Shortcuts() {
  const { allowed } = useAuth();
  // A run moving — or one put on the page, or taken off — is heard on the live stream; nothing is read signed out.
  const { automations, replace } = useAutomations({ when: allowed });
  const shortcuts = (automations ?? []).filter((automation) => automation.homePlace !== null).sort((a, b) => a.homePlace! - b.homePlace!);

  if (!shortcuts.length) return null;
  return (
    <YStack gap="$2">
      <SectionLabel>Shortcuts</SectionLabel>
      {shortcuts.map((automation) => (
        <AutomationCard key={automation.id} automation={automation} onChanged={replace} />
      ))}
    </YStack>
  );
}
