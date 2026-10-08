import { Button, Text, YStack } from 'tamagui';

import { Card, haptic } from '@kraftverk/ui';

/** What stands in for the app while an account's own family could not open here: why, and trying again. */
export function FamilyFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <YStack flex={1} backgroundColor="$background" alignItems="center" justifyContent="center" padding="$4">
      <Card width="100%" maxWidth={420} gap="$3">
        <Text role="heading" fontSize={18} fontWeight="700" color="$color">
          Your family could not open
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          {message}
        </Text>
        <Button size="$3" backgroundColor="$accent" color="$background" onPress={() => (haptic(), onRetry())}>
          Try again
        </Button>
      </Card>
    </YStack>
  );
}
