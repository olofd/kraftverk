import { useEffect, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { Text } from 'tamagui';

type Props = {
  value: number;
  format?: (value: number) => string;
  fontSize?: number;
  fontWeight?: '400' | '500' | '600' | '700' | '800';
  color?: string;
};

/**
 * Eases between values instead of snapping.
 *
 * Telemetry arrives every couple of seconds, and a wattage jumping 8 → 145 → 12
 * reads as flicker. Interpolating makes the same data feel like a live
 * instrument, and makes a real step change legible as movement rather than a
 * repaint.
 *
 * Driven by a listener rather than an animated style, because the value has to
 * pass through a formatter before it can be rendered as text.
 */
export function AnimatedNumber({
  value,
  format = (v) => String(Math.round(v)),
  fontSize = 22,
  fontWeight = '700',
  color = '$color',
}: Props) {
  const animated = useRef(new Animated.Value(value)).current;
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    const id = animated.addListener(({ value: v }) => setDisplay(v));
    return () => animated.removeListener(id);
  }, [animated]);

  useEffect(() => {
    const animation = Animated.timing(animated, {
      toValue: value,
      duration: 600,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [value, animated]);

  return (
    <Text
      fontSize={fontSize}
      fontWeight={fontWeight}
      color={color}
      fontVariant={['tabular-nums']}
      numberOfLines={1}
    >
      {format(display)}
    </Text>
  );
}
