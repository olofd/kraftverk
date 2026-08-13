import type { ReactNode } from 'react';
import { XStack, YStack } from 'tamagui';

/**
 * Tamagui's press styling on a plain wrapper, so a `Row` can be tapped.
 *
 * `Row` is a layout, not a button — which is right, because most rows are not
 * tappable. This is the one-line adapter for the ones that are, and it lives
 * here because two screens had grown their own identical copy.
 */
export function Pressable({ onPress, children }: { onPress: () => void; children: ReactNode }) {
  return (
    <XStack cursor="pointer" pressStyle={{ opacity: 0.6 }} onPress={onPress}>
      <YStack flex={1}>{children}</YStack>
    </XStack>
  );
}
