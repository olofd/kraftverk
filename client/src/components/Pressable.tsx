import type { ReactNode } from 'react';
import { XStack, YStack } from 'tamagui';

/**
 * Tamagui's press styling on a plain wrapper, so a `Row` can be tapped.
 *
 * `Row` is a layout, not a button — which is right, because most rows are not
 * tappable. This is the one-line adapter for the ones that are, and it lives
 * here because two screens had grown their own identical copy.
 */
export function Pressable({
  onPress,
  label,
  children,
}: {
  onPress: () => void;
  /** Announced to a screen reader when the row's own text is not enough. */
  label?: string;
  children: ReactNode;
}) {
  return (
    <XStack
      /*
        A tappable row is a button, and on the web that means reachable by Tab
        and operable by Enter or Space. It was a plain div: a keyboard could not
        get to it at all, which on a browser-first app is most of the app.

        The role earns the keys — react-native-web gives Enter and Space to
        `button` for free, which is why no key handler is needed here and the
        switch, which is not a button, has to attach one itself.
      */
      role="button"
      tabIndex={0}
      aria-label={label}
      cursor="pointer"
      pressStyle={{ opacity: 0.6 }}
      focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
      onPress={onPress}
    >
      <YStack flex={1}>{children}</YStack>
    </XStack>
  );
}
