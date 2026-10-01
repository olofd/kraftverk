import type { ComponentProps, ReactNode } from 'react';
import { Feather } from '@expo/vector-icons';
import { XStack, YStack } from 'tamagui';

export type IconName = ComponentProps<typeof Feather>['name'];

/**
 * An icon beside words: seen, not read. Feather draws each one as a glyph of
 * an icon font, and a screen reader read that glyph into the name of whatever
 * held it: a button called " Reset". Every icon here stands next to words
 * that say the same; one that stands alone gets its name from what holds it
 * (`aria-label`), never from the glyph.
 *
 * Its line is exactly as tall as it is wide: a glyph's box is then its em
 * square, and centring the box centres the icon. With the font's own line
 * height the box was taller than the glyph, and every icon sat a pixel or two
 * off — set right by hand, differently each time.
 */
export function Icon({ style, ...props }: ComponentProps<typeof Feather>) {
  const size = props.size ?? 12;
  return <Feather aria-hidden {...props} style={[{ lineHeight: size, width: size, height: size, textAlign: 'center' }, style]} />;
}

/**
 * An icon before words, centred on their first line however many lines they
 * run to — an icon and its label lined up by construction, never by a nudge.
 * `lineHeight` is the label's.
 */
export function IconLabel({ icon, size = 16, color, lineHeight, gap = 8, children }: { icon: IconName; size?: number; color?: string; lineHeight: number; gap?: number; children: ReactNode }) {
  return (
    <XStack alignItems="flex-start" gap={gap} data-icon-label="">
      <YStack height={lineHeight} justifyContent="center" data-icon-box="">
        <Icon name={icon} size={size} color={color} />
      </YStack>
      <YStack flex={1}>{children}</YStack>
    </XStack>
  );
}
