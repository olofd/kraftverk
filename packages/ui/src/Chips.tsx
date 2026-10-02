import { Text, XStack } from 'tamagui';

import { haptic } from './haptics.ts';
import { useRadioGroup } from './radio-group.ts';

/**
 * A choice among a few, as pills: the chosen one filled. A radio group, for a
 * screen reader and a keyboard — one Tab stop, the arrows between them, Enter
 * or Space to choose. They wrap rather than leave the screen, and none is
 * under 40 px to touch; a choice among many is a list to pick from instead.
 */
export function Chips<T extends string | number | boolean>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T | null; onChange: (value: T) => void }) {
  const radio = useRadioGroup(
    options.length,
    options.findIndex((option) => option.value === value),
    (index) => onChange(options[index]!.value)
  );
  return (
    <XStack gap="$2" flexWrap="wrap" flexShrink={1} maxWidth="100%" role="radiogroup" aria-label={label}>
      {options.map((option, index) => {
        const chosen = option.value === value;
        return (
          <XStack
            key={String(option.value)}
            role="radio"
            aria-checked={chosen}
            aria-label={option.label}
            {...radio(index)}
            cursor="pointer"
            minHeight={40}
            paddingHorizontal="$3.5"
            alignItems="center"
            justifyContent="center"
            borderRadius={999}
            borderWidth={1}
            borderColor={chosen ? '$accent' : '$borderColor'}
            backgroundColor={chosen ? '$accent' : '$background'}
            focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
            onPress={() => (haptic(), onChange(option.value))}
          >
            <Text fontSize={14} fontWeight={chosen ? '700' : '500'} color={chosen ? '$background' : '$color'}>
              {option.label}
            </Text>
          </XStack>
        );
      })}
    </XStack>
  );
}
