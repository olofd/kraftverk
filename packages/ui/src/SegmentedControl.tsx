import { useState } from 'react';
import { Platform } from 'react-native';
import { Text, useTheme, XStack, YStack } from 'tamagui';

import { haptic } from './haptics.ts';
import { PendingMark } from './PendingMark.tsx';
import { useRadioGroup } from './radio-group.ts';

type Option<T extends string | number> = { value: T; label: string };

const PAD = 3;
const GAP = 3;
/** How wide an option is meant to be at the least: a finger's width. */
const TOUCH = 44;

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
  const choose = (option: Option<T>) => {
    if (locked || option.value === value) return;
    haptic();
    onChange(option.value);
  };
  const radio = useRadioGroup(
    options.length,
    options.findIndex((option) => option.value === value),
    (index) => choose(options[index]!)
  );
  /*
    Rows of equal length. Six delays do not fit a 320 px phone at a finger's
    width each: rather than five and one left over, they go three and three.
    How many fit is known once it is laid out; until then, one row.
  */
  const [width, setWidth] = useState(0);
  const inner = width - PAD * 2;
  const fit = width ? Math.max(1, Math.floor((inner + GAP) / (TOUCH + GAP))) : options.length;
  const perRow = Math.ceil(options.length / Math.ceil(options.length / Math.min(fit, options.length)));
  const basis = width ? Math.floor((inner - GAP * (perRow - 1)) / perRow) : 0;

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
        padding={PAD}
        gap={GAP}
        flexWrap="wrap"
        role="radiogroup"
        aria-label={title}
        aria-busy={pending || undefined}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {options.map((option, index) => {
          const selected = option.value === value;
          return (
            <XStack
              key={option.value}
              {...radio(index)}
              // Equal shares of a row; never narrower than the label, so a label longer than its share wraps the row rather than being cut.
              flexGrow={1}
              flexShrink={0}
              flexBasis={basis}
              minWidth={Platform.OS === 'web' ? ('max-content' as never) : undefined}
              role="radio"
              aria-checked={selected}
              aria-disabled={locked || undefined}
              focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid', outlineOffset: 1 }}
              justifyContent="center"
              alignItems="center"
              minHeight={40}
              paddingHorizontal={2}
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
