import { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { Text, useTheme, XStack, YStack } from 'tamagui';

import { Toggle } from '@kraftverk/ui';

import type { Plug } from './plug';
import { clock } from './words';

/*
  Live readings.

  Whether they are wanted is the plug's session's to keep, on the server: one
  wish for every screen and every person. Switching them off switches them
  off everywhere, and no screen turns them back on. Switched on, they stay on
  for a quarter of an hour; a screen that shows them keeps that going for as
  long as it is open — but only while they are on.
*/

/** Less than this left, and an open screen asks for another quarter of an hour. */
const EXTEND_WITHIN_MS = 3 * 60_000;

export type Live = {
  on: boolean;
  /** Seconds left, while on. */
  left: number | null;
  pending: boolean;
  set: (on: boolean) => void;
};

export function useLive(plug: Plug): Live {
  const on = plug.value('live') === true;
  const until = plug.value('liveUntil');
  const ends = typeof until === 'string' ? Date.parse(until) : null;
  const pending = plug.pending('live');
  const { canChange, write } = plug;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);

  // Watched, and on: kept on while watched. Never turned on from here unasked.
  const due = on && ends !== null && ends - now < EXTEND_WITHIN_MS;
  const asked = useRef(0);
  useEffect(() => {
    // Once in a while at most: a refusal must not become a loop.
    if (!due || pending || !canChange || Date.now() - asked.current < 30_000) return;
    asked.current = Date.now();
    void write({ live: true });
  }, [due, pending, canChange, write]);

  return {
    on,
    left: on && ends !== null ? Math.max(0, (ends - now) / 1000) : null,
    pending,
    set: (next) => void write({ live: next }),
  };
}

/** A dot that breathes while readings arrive every second. */
export function Pulse({ active }: { active: boolean }) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 700, useNativeDriver: false }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [active, opacity]);
  return <Animated.View style={{ width: 10, height: 10, borderRadius: 5, opacity, backgroundColor: (active ? theme.success?.val : theme.muted?.val) as string }} />;
}

/** The switch for live readings, with what it means right now. */
export function LiveStrip({ live, disabled }: { live: Live; disabled: boolean }) {
  const detail = live.on
    ? `A reading every second, for ${clock(live.left ?? 0)} more — kept going while this is open.`
    : 'A reading every second, for when you are changing something and want to see it land.';
  return (
    <XStack alignItems="center" gap="$3" backgroundColor="$background" borderRadius="$4" paddingHorizontal="$3" paddingVertical={10}>
      <Pulse active={live.on} />
      <YStack flex={1} gap={1}>
        <Text fontSize={14} fontWeight="700" color="$color">
          {live.on ? 'Live' : 'Live readings'}
        </Text>
        <Text fontSize={12} color="$muted" lineHeight={16}>
          {detail}
        </Text>
      </YStack>
      <Toggle label="Live readings" checked={live.on} pending={live.pending} disabled={disabled} onCheckedChange={live.set} />
    </XStack>
  );
}
