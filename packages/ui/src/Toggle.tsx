import { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { XStack, useTheme } from 'tamagui';

import { haptic } from './haptics';

/**
 * An on/off switch, drawn explicitly rather than themed.
 *
 * Tamagui's `Switch` sizes itself from the `size` token scale, and this app's
 * scale is its own — so it came out as a 31×18 square thumb sitting 3px from
 * the top of a 23px track, in the same position whether it was on or off. A
 * switch whose thumb does not move is not a switch.
 *
 * The geometry here is fixed and legible: a pill track, a round thumb inset by
 * the same amount on every side, and a translate that puts it against one edge
 * or the other. It is the same on web and native because none of it is
 * delegated.
 */

const TRACK_WIDTH = 46;
const TRACK_HEIGHT = 28;
/** Equal on all four sides, which is what makes the thumb look centred. */
const INSET = 3;
const THUMB = TRACK_HEIGHT - INSET * 2;
const TRAVEL = TRACK_WIDTH - THUMB - INSET * 2;

export type ToggleProps = {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
};

export function Toggle({ checked, onCheckedChange, disabled }: ToggleProps) {
  const theme = useTheme();

  /*
    Driven by `Animated` rather than a Tamagui `animation` prop, for the same
    reason `AnimatedNumber` is: the animation types come from the app's own
    Tamagui config, and a shared package cannot import the app. This works on
    web and native without either.
  */
  const slide = useRef(new Animated.Value(checked ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(slide, {
      toValue: checked ? 1 : 0,
      duration: 160,
      useNativeDriver: true,
    }).start();
  }, [checked, slide]);

  return (
    <XStack
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      width={TRACK_WIDTH}
      height={TRACK_HEIGHT}
      borderRadius={999}
      padding={INSET}
      alignItems="center"
      justifyContent="flex-start"
      backgroundColor={checked ? '$success' : '$backgroundPress'}
      opacity={disabled ? 0.5 : 1}
      cursor={disabled ? 'default' : 'pointer'}
      transition="fast"
      pressStyle={disabled ? undefined : { opacity: 0.8 }}
      onPress={() => {
        if (disabled) return;
        haptic();
        onCheckedChange(!checked);
      }}
    >
      {/*
        A transform rather than a layout change: it can be animated on the
        native driver, and it cannot reflow the row the switch sits in.
      */}
      <Animated.View
        style={{
          width: THUMB,
          height: THUMB,
          borderRadius: 999,
          backgroundColor: theme.white?.val ?? '#ffffff',
          transform: [
            { translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [0, TRAVEL] }) },
          ],
        }}
      />
    </XStack>
  );
}
