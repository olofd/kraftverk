import { router } from 'expo-router';
import { Button, Text, XStack, YStack } from 'tamagui';

import type { AutomationView } from '@kraftverk/api-client';
import { haptic, Icon } from '@kraftverk/ui';

import { AutomationCard } from './AutomationCard';
import { useTone } from './looks';

/**
 * A list of automations, the same wherever it is (docs/AUTOMATIONS-UX.md): a
 * heading with how many, a button that makes a new one, and a card for each —
 * all of them on the automations screen, those a device takes part in on its
 * page. `device`: the device the list is for; a new one is made from it.
 */
export function AutomationList({
  automations,
  onChanged,
  title,
  device,
  empty,
}: {
  automations: readonly AutomationView[];
  onChanged: (next: AutomationView) => void;
  /** A heading of its own, where the screen's title is about something else: "Automations" on a device's page. */
  title?: string;
  device?: { id: string; name: string };
  /** What an empty list says. */
  empty: string;
}) {
  const tone = useTone();
  const count = automations.length;
  return (
    <YStack gap="$3" role={title ? 'region' : undefined} aria-label={title}>
      <XStack alignItems="center" justifyContent="space-between" gap="$3">
        <YStack flex={1} gap={2}>
          {title ? (
            <Text role="heading" aria-level={2} fontSize={18} fontWeight="700" color="$color">
              {title}
            </Text>
          ) : null}
          <Text fontSize={14} color="$muted">
            {count ? `${count} automation${count === 1 ? '' : 's'}` : 'None yet'}
          </Text>
        </YStack>
        <Button
          size="$4"
          backgroundColor="$accent"
          color="$background"
          icon={<Icon name="plus" size={16} color={tone('$background')} />}
          aria-label={device ? `New automation with ${device.name}` : 'New automation'}
          onPress={() => (haptic(), router.push(device ? `/automation/new?device=${encodeURIComponent(device.id)}` : '/automation/new'))}
        >
          New
        </Button>
      </XStack>
      {count ? (
        automations.map((automation) => <AutomationCard key={automation.id} automation={automation} onChanged={onChanged} />)
      ) : (
        <Text fontSize={14} color="$muted" lineHeight={20}>
          {empty}
        </Text>
      )}
    </YStack>
  );
}
