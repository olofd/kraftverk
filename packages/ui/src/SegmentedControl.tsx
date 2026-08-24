import { Text, useTheme, XStack, YStack } from 'tamagui';

import { haptic } from './haptics';

type Option<T extends string | number> = { value: T; label: string };

type Props<T extends string | number> = {
  title: string;
  subtitle?: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
};

export function SegmentedControl<T extends string | number>({
  title,
  subtitle,
  value,
  options,
  onChange,
}: Props<T>) {
  /*
    The resolved value, not the token.

    `backgroundColor="$card"` inside a styled() definition compiles to the theme's
    CSS variable and follows light and dark correctly. Written inline as a
    conditional it does not: it resolves against a baked-in default instead, which
    in the light theme paints a dark slate behind the near-black selected label and
    makes it unreadable. Reading the value off the theme keeps both schemes honest.
  */
  const theme = useTheme();

  return (
    <YStack gap="$3" paddingHorizontal="$4" paddingVertical="$3">
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

      <XStack
        backgroundColor="$backgroundPress"
        borderRadius="$3"
        padding={3}
        gap={3}
        role="radiogroup"
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <XStack
              key={option.value}
              flex={1}
              role="radio"
              aria-checked={selected}
              justifyContent="center"
              paddingVertical="$2"
              borderRadius="$2"
              cursor="pointer"
              backgroundColor={selected ? theme.card?.val : 'transparent'}
              transition="fast"
              hoverStyle={selected ? undefined : { backgroundColor: '$backgroundHover' }}
              pressStyle={{ opacity: 0.7 }}
              onPress={() => {
                if (selected) return;
                haptic();
                onChange(option.value);
              }}
            >
              <Text
                fontSize={13}
                fontWeight={selected ? '700' : '500'}
                color={selected ? '$color' : '$muted'}
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
