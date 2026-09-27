import { Text, useTheme, XStack, YStack } from 'tamagui';

import { haptic } from './haptics';
import { PendingMark } from './PendingMark';

type Option<T extends string | number> = { value: T; label: string };

type Props<T extends string | number> = {
  title: string;
  subtitle?: string;
  value: T;
  options: readonly Option<T>[];
  disabled?: boolean;
  /**
   * The device has not confirmed `value` yet: it is shown as chosen, and the
   * row is locked until it does.
   */
  pending?: boolean;
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
  pending,
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
  const locked = disabled || pending;

  return (
    // Always stacked. A side-by-side layout looked tidier with two options but
    // clipped the title once a control had five, so the label always gets its
    // own line and the options share the full width below it.
    <YStack paddingHorizontal="$4" paddingVertical="$3" gap="$3" opacity={disabled ? 0.45 : 1}>
      <YStack gap={2}>
        <XStack alignItems="center" justifyContent="space-between" gap="$2">
          <Text fontSize={15} fontWeight="600" color="$color" flexShrink={1}>
            {title}
          </Text>
          {pending ? <PendingMark /> : null}
        </XStack>
        {subtitle ? (
          <Text fontSize={12} color="$muted" lineHeight={17}>
            {subtitle}
          </Text>
        ) : null}
      </YStack>

      <XStack
        backgroundColor="$backgroundPress"
        borderRadius="$3"
        padding={3}
        gap={3}
        role="radiogroup"
        aria-busy={pending || undefined}
      >
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
              aria-disabled={locked || undefined}
              paddingHorizontal="$2"
              paddingVertical="$2"
              borderRadius="$2"
              cursor={locked ? 'default' : 'pointer'}
              // No `transition`: see SegmentedControl — a colour animated by
              // the driver can replay long after the choice has settled.
              backgroundColor={selected ? theme.card?.val : 'transparent'}
              hoverStyle={selected || locked ? undefined : { backgroundColor: '$backgroundHover' }}
              pressStyle={locked ? undefined : { opacity: 0.7 }}
              onPress={() => {
                if (locked || selected) return;
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
