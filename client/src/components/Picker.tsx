import { useState } from 'react';
import { Text, XStack, YStack } from 'tamagui';

import { Icon } from '@kraftverk/ui';

import { Pressable } from './Pressable';
import { useTone } from './tone';

/**
 * One choice among many, shown as what is chosen: a tap opens the list
 * beneath, a pick closes it. For a part, a reading, a setting, an automation,
 * a kind of condition, a comparison.
 */
export function Picker<T>({
  label,
  chosen,
  placeholder,
  options,
  onPick,
}: {
  label: string;
  chosen: string | null;
  placeholder: string;
  options: readonly { key: string; title: string; subtitle?: string; value: T; selected?: boolean }[];
  onPick: (value: T) => void;
}) {
  const tone = useTone();
  const [open, setOpen] = useState(false);
  return (
    <YStack gap="$1.5">
      <Pressable onPress={() => setOpen((was) => !was)} label={`${label}: ${chosen ?? placeholder}. ${open ? 'Close' : 'Choose'}`}>
        <XStack alignItems="center" gap="$2" paddingHorizontal="$3" minHeight={44} borderRadius="$4" borderWidth={1} borderColor={chosen ? '$borderColor' : '$warning'} backgroundColor="$background">
          <Text flex={1} fontSize={15} fontWeight={chosen ? '600' : '400'} color={chosen ? '$color' : '$warning'} numberOfLines={1}>
            {chosen ?? placeholder}
          </Text>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} color={tone('$muted')} />
        </XStack>
      </Pressable>
      {open ? (
        <YStack borderRadius="$4" borderWidth={1} borderColor="$borderColor" overflow="hidden" backgroundColor="$background">
          {options.length ? (
            options.map((option, index) => (
              <YStack key={option.key} borderTopWidth={index ? 1 : 0} borderColor="$borderColor">
                <Pressable selected={option.selected ?? false} onPress={() => (setOpen(false), onPick(option.value))}>
                  <YStack paddingHorizontal="$3" paddingVertical="$2.5" minHeight={44} justifyContent="center" gap={2}>
                    <Text fontSize={15} color="$color">
                      {option.title}
                    </Text>
                    {option.subtitle ? (
                      <Text fontSize={12} color="$muted">
                        {option.subtitle}
                      </Text>
                    ) : null}
                  </YStack>
                </Pressable>
              </YStack>
            ))
          ) : (
            <Text padding="$3" fontSize={14} color="$muted">
              Nothing you have fits here.
            </Text>
          )}
        </YStack>
      ) : null}
    </YStack>
  );
}
