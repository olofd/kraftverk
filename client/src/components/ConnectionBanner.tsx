import { Feather } from '@expo/vector-icons';
import { Button, Text, useTheme, XStack, YStack } from 'tamagui';

import { useDirectLink } from '../state/DirectLinkProvider';
import { useDevices } from '../state/DevicesProvider';

/**
 * Only renders when something is actually wrong.
 *
 * "Wrong" means a link the user asked for is not working: a station this app
 * was holding has gone quiet, or a server they added is not answering. Running
 * with no server at all is not wrong — it is what this app does in a browser —
 * so local mode says nothing rather than showing a red banner about an address
 * nobody chose.
 */
export function ConnectionBanner() {
  const { connection, error, refresh } = useDevices();
  const { source, servers } = useDirectLink();
  const theme = useTheme();

  if (connection !== 'offline') return null;
  // Server mode with nothing selected is a moment mid-switch, not a fault.
  if (source === 'server' && !servers.active) return null;

  // Blaming a server is wrong when the app is holding the Bluetooth link
  // itself — there is no server in that path at all.
  const direct = source === 'direct';

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
      <Feather
        name={direct ? 'bluetooth' : 'wifi-off'}
        size={18}
        color={theme.danger?.val ?? '#ef4444'}
      />
      <YStack flex={1} gap={2}>
        <Text fontSize={14} fontWeight="700" color="$danger">
          {direct ? 'Lost the station' : `Can't reach ${servers.active?.name ?? 'the server'}`}
        </Text>
        <Text fontSize={12} color="$muted">
          {error ?? (direct ? 'The Bluetooth link went quiet' : servers.active?.url)}
        </Text>
      </YStack>
      <Button size="$2" onPress={() => void refresh()}>
        Retry
      </Button>
    </XStack>
  );
}
