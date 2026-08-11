import { Text, XStack, YStack } from 'tamagui';

import { haptic } from '../lib/haptics';

type Option<T extends string> = { value: T; label: string };

type Props<T extends string> = {
  title: string;
  subtitle?: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
};

export function SegmentedControl<T extends string>({
  title,
  subtitle,
  value,
  options,
  onChange,
}: Props<T>) {
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
              backgroundColor={selected ? '$card' : 'transparent'}
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
