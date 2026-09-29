import { createElement, useEffect, useRef } from 'react';
import { ActivityIndicator, Animated, Platform } from 'react-native';
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
  /**
   * The device has not confirmed this position yet.
   *
   * Drawn in the position that was asked for, with a spinner in the thumb, and
   * locked: a second tap before the first is confirmed is a second write to
   * hardware that is still busy with the first.
   */
  pending?: boolean;
};

export function Toggle({ checked, onCheckedChange, disabled, pending }: ToggleProps) {
  const theme = useTheme();
  const locked = disabled || pending;

  /*
    One value moves the thumb *and* colours the track, so the two cannot
    disagree.

    The track used to be coloured by Tamagui's `transition`, apart from the
    thumb. That driver animates a colour by flipping a shared value between 0
    and 1 and rebuilding the interpolation from the colour it last saw, and
    once that bookkeeping fell out of step it replayed a green-to-grey change
    on later renders with nothing having changed. Telemetry re-renders the
    screen every two seconds, so a switch that was off drew its track green,
    then grey, over and over, while the thumb sat still at off. It was
    reproduced after a change that was set and set back within a moment; with
    the colour taken from the thumb's own value, no trigger can do it again.

    Driven by `Animated` rather than a Tamagui `animation` prop, for the same
    reason `AnimatedNumber` is: the animation types come from the app's own
    Tamagui config, and a shared package cannot import the app. Not on the
    native driver, which cannot animate a colour; this is one small view.
  */
  const slide = useRef(new Animated.Value(checked ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(slide, {
      toValue: checked ? 1 : 0,
      duration: 160,
      useNativeDriver: false,
    }).start();
  }, [checked, slide]);

  const off = theme.backgroundPress?.val ?? '#d1d5db';
  const on = theme.success?.val ?? '#16a34a';
  const flip = () => {
    if (locked) return;
    haptic();
    onCheckedChange(!checked);
  };

  const track = (
    <Animated.View
      style={{
        flex: 1,
        borderRadius: 999,
        padding: INSET,
        justifyContent: 'center',
        backgroundColor: slide.interpolate({ inputRange: [0, 1], outputRange: [off, on] }),
      }}
    >
      {/*
        A transform rather than a layout change: it cannot reflow the row the
        switch sits in.
      */}
      <Animated.View
        style={{
          width: THUMB,
          height: THUMB,
          borderRadius: 999,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.white?.val ?? '#ffffff',
          transform: [{ translateX: slide.interpolate({ inputRange: [0, 1], outputRange: [0, TRAVEL] }) }],
        }}
      >
        {pending ? <ActivityIndicator size="small" color={theme.muted?.val} style={{ transform: [{ scale: 0.7 }] }} /> : null}
      </Animated.View>
    </Animated.View>
  );

  /*
    On the web, a real `<button role="switch">`: the browser gives it Tab, a
    focus ring, and Space and Enter, which no handler on a Tamagui view ever
    received (an `onKeyDown` prop, a listener through the ref and
    `role="button"` were all tried). Disabled while locked, so a second press
    cannot race the first.
  */
  if (Platform.OS === 'web') {
    return createElement(
      'button',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-busy': pending || undefined,
        disabled: locked,
        onClick: flip,
        style: {
          display: 'flex',
          width: TRACK_WIDTH,
          height: TRACK_HEIGHT,
          padding: 0,
          margin: 0,
          border: 'none',
          borderRadius: 999,
          background: 'transparent',
          // Dimmed when it cannot be used at all; a pending switch stays bright, because the position it shows is the one being made true.
          opacity: disabled ? 0.5 : 1,
          cursor: locked ? 'default' : 'pointer',
          outlineOffset: 2,
          flexShrink: 0,
        },
      },
      track
    );
  }

  return (
    <XStack
      role="switch"
      aria-checked={checked}
      aria-disabled={locked}
      aria-busy={pending || undefined}
      width={TRACK_WIDTH}
      height={TRACK_HEIGHT}
      borderRadius={999}
      // Dimmed when it cannot be used at all; a pending switch stays bright,
      // because the position it shows is the one being made true.
      opacity={disabled ? 0.5 : 1}
      cursor={locked ? 'default' : 'pointer'}
      pressStyle={locked ? undefined : { opacity: 0.8 }}
      onPress={flip}
    >
      {track}
    </XStack>
  );
}
