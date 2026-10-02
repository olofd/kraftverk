import { useEffect, useState } from 'react';
import { router, useIsFocused } from 'expo-router';
import { Button, Text, useTheme, XStack, YStack } from 'tamagui';

import type { ElsewhereView } from '@kraftverk/api-client';
import { Card, haptic, Icon } from '@kraftverk/ui';

import { useHome } from '../../state/HomeProvider';

/**
 * What the home's transports can see that nothing you have is reached by:
 * a station that connected to its broker, a plug broadcasting on the network.
 * Choosing one skips straight to checking it.
 */
/**
 * A home this app keeps beside this one, offered to bring in
 * (docs/PLAN-SHARED-CORE.md, phase 6h): with a server, the home the app
 * kept itself before it had one — the server takes it over; with none, the
 * copy it kept of the server it used last — kept here. What it would do is
 * the import's plan, seen before anything moves.
 */
export function Elsewhere() {
  const { api } = useHome();
  const theme = useTheme();
  const [elsewhere, setElsewhere] = useState<ElsewhereView>(null);
  const focused = useIsFocused();
  useEffect(() => {
    if (!focused) return;
    let live = true;
    void api.configuration
      .elsewhere()
      .then((found) => live && setElsewhere(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, focused]);
  if (!elsewhere) return null;
  const what = [elsewhere.devices && `${elsewhere.devices} ${elsewhere.devices === 1 ? 'device' : 'devices'}`, elsewhere.automations && `${elsewhere.automations} ${elsewhere.automations === 1 ? 'automation' : 'automations'}`].filter(Boolean).join(' and ');
  const [title, detail, action] =
    elsewhere.from === 'this-node'
      ? ([`This app kept a home of its own: ${what}`, `Your server can take it over, and run it while the app is closed. What this app reaches over its own radio stays with it, near the device.`, 'See what moves'] as const)
      : ([`This app kept your server’s home: ${what}`, 'As your server last said it. Keep it here, and it runs while the app is open; what only a server can reach waits for one.', 'See what is kept'] as const);
  return (
    <Card gap="$3" alignItems="flex-start" borderColor="$accent">
      <XStack gap="$3" alignItems="flex-start">
        <Icon name="home" size={18} color={theme.accent?.val} />
        <YStack flex={1} gap="$1">
          <Text fontSize={15} fontWeight="700" color="$color">
            {title}
          </Text>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {detail}
          </Text>
        </YStack>
      </XStack>
      <Button
        size="$3"
        backgroundColor="$accent"
        color="$background"
        onPress={() => {
          haptic();
          router.push(`/configuration?import=1&from=${elsewhere.from}`);
        }}
      >
        {action}
      </Button>
    </Card>
  );
}
