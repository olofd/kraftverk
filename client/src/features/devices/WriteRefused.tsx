import { Feather } from '@expo/vector-icons';
import { Text, useTheme, XStack } from 'tamagui';

import { Card } from '@kraftverk/ui';

/**
 * Why the last change did not happen.
 *
 * A refused or unconfirmed write puts its control back where the device says it
 * is. Without the reason next to it, that is indistinguishable from a control
 * that bounced — so it is said, until the next change is asked for.
 */
export function WriteRefused({ message }: { message: string | null }) {
  const theme = useTheme();
  if (!message) return null;

  return (
    <Card borderColor="$danger" role="alert">
      <XStack gap="$2.5" alignItems="flex-start">
        <Feather name="alert-circle" size={15} color={theme.danger?.val} style={{ marginTop: 2 }} />
        <Text flex={1} fontSize={13} color="$danger" lineHeight={19}>
          {message}
        </Text>
      </XStack>
    </Card>
  );
}
