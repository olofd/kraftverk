import { Text, XStack, YStack } from 'tamagui';

import { haptic } from '../lib/haptics';

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
  return (
    <YStack
      paddingHorizontal="$4"
      paddingVertical="$3"
      gap="$3"
      opacity={disabled ? 0.45 : 1}
      $gtXs={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
    >
      <YStack flex={1} gap={2}>
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
              role="radio"
              aria-checked={selected}
              paddingHorizontal="$3"
              paddingVertical="$2"
              borderRadius="$2"
              cursor={disabled ? 'default' : 'pointer'}
              backgroundColor={selected ? '$card' : 'transparent'}
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
