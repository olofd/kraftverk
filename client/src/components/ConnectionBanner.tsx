import { Feather } from '@expo/vector-icons';
import { Button, Text, useTheme, XStack, YStack } from 'tamagui';

import { useStation } from '../state/StationProvider';

/** Only renders when something is wrong — otherwise it stays out of the way. */
export function ConnectionBanner() {
  const { connection, error, apiBaseUrl, source, refresh } = useStation();
  const theme = useTheme();

  if (connection !== 'offline') return null;

  // Blaming the API server is wrong when the app is holding the Bluetooth link
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
          {direct ? 'Lost the station' : "Can't reach the API server"}
        </Text>
        <Text fontSize={12} color="$muted">
          {error ?? (direct ? 'The Bluetooth link went quiet' : apiBaseUrl)}
        </Text>
      </YStack>
      <Button size="$2" onPress={() => void refresh()}>
        Retry
      </Button>
    </XStack>
  );
}
