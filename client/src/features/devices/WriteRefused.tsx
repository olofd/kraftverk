import { Text, useTheme } from 'tamagui';

import { Card, IconLabel } from '@kraftverk/ui';

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
      <IconLabel icon="alert-circle" size={16} color={theme.danger?.val} lineHeight={19} gap={10}>
        <Text fontSize={13} color="$danger" lineHeight={19}>
          {message}
        </Text>
      </IconLabel>
    </Card>
  );
}
