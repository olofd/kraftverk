import { useRef } from 'react';
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
   * control is locked until it does.
   */
  pending?: boolean;
  onChange: (value: T) => void;
};

export function SegmentedControl<T extends string | number>({
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

    `backgroundColor="$card"` inside a styled() definition compiles to the theme's
    CSS variable and follows light and dark correctly. Written inline as a
    conditional it does not: it resolves against a baked-in default instead, which
    in the light theme paints a dark slate behind the near-black selected label and
    makes it unreadable. Reading the value off the theme keeps both schemes honest.
  */
  const theme = useTheme();
  const locked = disabled || pending;
  const refs = useRef<(HTMLElement | null)[]>([]);
  // One stop for Tab: the chosen option, or the first when none is.
  const current = Math.max(0, options.findIndex((option) => option.value === value));

  const choose = (option: Option<T>) => {
    if (locked || option.value === value) return;
    haptic();
    onChange(option.value);
  };
  /*
    The keyboard, as a radio group's: the arrows move between the options,
    and Space or Enter chooses the one it is on. Moving does not choose —
    a choice here can be consequential (letting an automation act asks
    first), so it is made on purpose, never by passing over it.
  */
  const onKeyDown = (index: number) => (event: { key: string; preventDefault: () => void }) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step) {
      event.preventDefault();
      refs.current[(index + step + options.length) % options.length]?.focus();
    } else if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      choose(options[index]!);
    }
  };

  return (
    <YStack gap="$3" paddingHorizontal="$4" paddingVertical="$3" opacity={disabled ? 0.45 : 1}>
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
        aria-label={title}
        aria-busy={pending || undefined}
      >
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <XStack
              key={option.value}
              ref={((element: HTMLElement | null) => void (refs.current[index] = element)) as never}
              flex={1}
              role="radio"
              aria-checked={selected}
              aria-disabled={locked || undefined}
              tabIndex={index === current ? 0 : -1}
              onKeyDown={onKeyDown(index) as never}
              focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid', outlineOffset: 1 }}
              justifyContent="center"
              paddingVertical="$2"
              borderRadius="$2"
              cursor={locked ? 'default' : 'pointer'}
              /*
                No `transition`. Tamagui's driver animates a colour by flipping
                a shared value and rebuilding the interpolation from the colour
                it last saw, and once that falls out of step it replays an old
                colour on later renders — which is what made the switches
                flash. The choice changes at once instead.
              */
              // The choice filled with the accent: seen at a glance, not a shade darker than the rest.
              backgroundColor={selected ? theme.accent?.val : 'transparent'}
              hoverStyle={selected || locked ? undefined : { backgroundColor: '$backgroundHover' }}
              pressStyle={locked ? undefined : { opacity: 0.7 }}
              onPress={() => choose(option)}
            >
              <Text
                fontSize={13}
                fontWeight={selected ? '700' : '500'}
                color={selected ? (theme.background?.val as string) : '$muted'}
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
