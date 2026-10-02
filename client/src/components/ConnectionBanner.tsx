import { Button, Text, useTheme, XStack, YStack } from 'tamagui';

import { Icon } from '@kraftverk/ui';

import { useDevices } from '../state/DevicesProvider';
import { useServers } from '../state/ServersProvider';

/**
 * Only renders when something is actually wrong: a server you added is not
 * answering. What is shown then is what it last said — read only — and
 * what this app reaches itself goes on; or, with nothing heard from it yet,
 * why not. A home the app keeps itself has no server to lose — its devices
 * are this app's own, and each says on its card whether it can be reached.
 */
export function ConnectionBanner() {
  const { homeReach: connection, error, refresh, devices } = useDevices();
  const servers = useServers();
  const theme = useTheme();

  if (connection !== 'offline' || !servers.active) return null;

  return (
    <XStack
      alignItems="center"
      gap="$3"
      padding="$3"
      borderRadius="$4"
      backgroundColor="$backgroundStrong"
      borderWidth={1}
      borderColor="$danger"
    >
      <Icon name="wifi-off" size={18} color={theme.danger?.val ?? '#ef4444'} />
      <YStack flex={1} gap={2}>
        <Text fontSize={14} fontWeight="700" color="$danger">
          {`Can't reach ${servers.active.name}`}
        </Text>
        <Text fontSize={12} color="$muted">
          {error ?? (devices.length ? 'Shown as it last said: nothing changes through it until it answers. What this app reaches itself still works.' : servers.active.url)}
        </Text>
      </YStack>
      <Button size="$2" onPress={() => void refresh()}>
        Retry
      </Button>
    </XStack>
  );
}
