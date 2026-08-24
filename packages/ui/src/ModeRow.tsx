import { Text, useTheme, XStack, YStack } from 'tamagui';

import { haptic } from './haptics';

type Option<T extends string | number> = { value: T; label: string };

type Props<T extends string | number> = {
  title: string;
  subtitle?: string;
  value: T;
  options: readonly Option<T>[];
  disabled?: boolean;
  onChange: (value: T) => void;
};

/**
 * A list row whose accessory is a compact multi-way selector.
 *
 * For controls with more than two states — the light is off / on / SOS / flash
 * — where a switch would throw away meaning.
 */
export function ModeRow<T extends string | number>({
  title,
  subtitle,
  value,
  options,
  disabled,
  onChange,
}: Props<T>) {
  /*
    The resolved value, not the token.

    `backgroundColor="$card"` inside a styled() definition compiles to the
    theme's CSS variable and follows light and dark correctly. Written inline as
    a conditional it does not: it resolves against a baked-in default instead,
    which in the light theme paints a dark slate behind the near-black selected
    label and makes it unreadable. Reading the value off the theme keeps both
    schemes honest.
  */
  const theme = useTheme();

  return (
    // Always stacked. A side-by-side layout looked tidier with two options but
    // clipped the title once a control had five, so the label always gets its
    // own line and the options share the full width below it.
    <YStack paddingHorizontal="$4" paddingVertical="$3" gap="$3" opacity={disabled ? 0.45 : 1}>
      <YStack gap={2}>
        <Text fontSize={15} fontWeight="600" color="$color">
          {title}
        </Text>
        {subtitle ? (
          <Text fontSize={12} color="$muted" lineHeight={17}>
            {subtitle}
          </Text>
        ) : null}
      </YStack>

      <XStack backgroundColor="$backgroundPress" borderRadius="$3" padding={3} gap={3}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <XStack
              key={String(option.value)}
              // Equal shares, so five options fit a phone without overflowing.
              flex={1}
              justifyContent="center"
              role="radio"
              aria-checked={selected}
              paddingHorizontal="$2"
              paddingVertical="$2"
              borderRadius="$2"
              cursor={disabled ? 'default' : 'pointer'}
              backgroundColor={selected ? theme.card?.val : 'transparent'}
              transition="fast"
              hoverStyle={selected || disabled ? undefined : { backgroundColor: '$backgroundHover' }}
              pressStyle={disabled ? undefined : { opacity: 0.7 }}
              onPress={() => {
                if (disabled || selected) return;
                haptic();
                onChange(option.value);
              }}
            >
              <Text
                fontSize={13}
                fontWeight={selected ? '700' : '500'}
                color={selected ? '$color' : '$muted'}
                numberOfLines={1}
              >
                {option.label}
              </Text>
            </XStack>
          );
        })}
      </XStack>
    </YStack>
  );
}
