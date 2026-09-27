import { ActivityIndicator } from 'react-native';
import { Text, useTheme, XStack } from 'tamagui';

/**
 * "The device has not confirmed this yet", beside a control's title.
 *
 * One mark for every control that writes to hardware, so a pending switch, a
 * pending choice and a pending slider all say the same thing the same way.
 */
export function PendingMark() {
  const theme = useTheme();
  return (
    <XStack alignItems="center" gap="$1.5" aria-live="polite">
      <ActivityIndicator size="small" color={theme.muted?.val} style={{ transform: [{ scale: 0.7 }] }} />
      <Text fontSize={12} color="$muted">
        Waiting for the device
      </Text>
    </XStack>
  );
}
