import { Text, XStack, YStack } from 'tamagui';

import { haptic } from './haptics.ts';

/**
 * Any of a few, as pills: each chosen one filled, a dot of its colour beside
 * it when it has one. Checkboxes, for a screen reader — each its own Tab
 * stop, Enter or Space to turn it on or off. They wrap rather than leave the
 * screen, and none is under 40 px to touch. One choice of a few is `Chips`.
 */
export function ToggleChips<T extends string>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string; color?: string | null }[]; value: readonly T[]; onChange: (value: T[]) => void }) {
  const toggle = (option: T) => (haptic(), onChange(value.includes(option) ? value.filter((each) => each !== option) : [...value, option]));
  return (
    <XStack gap="$2" flexWrap="wrap" flexShrink={1} maxWidth="100%" role="group" aria-label={label}>
      {options.map((option) => {
        const chosen = value.includes(option.value);
        return (
          <XStack
            key={option.value}
            role="checkbox"
            aria-checked={chosen}
            aria-label={option.label}
            tabIndex={0}
            cursor="pointer"
            minHeight={40}
            gap="$2"
            paddingHorizontal="$3.5"
            alignItems="center"
            justifyContent="center"
            borderRadius={999}
            borderWidth={1}
            borderColor={chosen ? '$accent' : '$borderColor'}
            backgroundColor={chosen ? '$accent' : '$background'}
            focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
            onPress={() => toggle(option.value)}
            onKeyDown={(event: { key: string; preventDefault: () => void }) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              toggle(option.value);
            }}
          >
            {option.color ? <YStack width={10} height={10} borderRadius={5} backgroundColor={option.color as never} borderWidth={1} borderColor="$background" /> : null}
            <Text fontSize={14} fontWeight={chosen ? '700' : '500'} color={chosen ? '$background' : '$color'}>
              {option.label}
            </Text>
          </XStack>
        );
      })}
    </XStack>
  );
}
