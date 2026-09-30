import { Text, YStack } from 'tamagui';

/** Where the thing measured is now, on a slider's track: "234 V now". */
export type Marker = { value: number; label: string };

/**
 * A tick above a slider's track with a short label, at the marker's place
 * between the track's ends. Past either end it sits at the end, so a reading
 * outside the range still shows which side it is on.
 */
export function SliderMarker({ marker, min, max }: { marker: Marker; min: number; max: number }) {
  const at = Math.min(1, Math.max(0, (marker.value - min) / (max - min || 1)));
  return (
    // A fixed width centred on the point: a percentage translate is not there on native.
    <YStack position="absolute" top={0} left={`${at * 100}%`} width={64} marginLeft={-32} alignItems="center" pointerEvents="none" zIndex={1}>
      <Text fontSize={10} fontWeight="700" color="$color" fontVariant={['tabular-nums']} numberOfLines={1}>
        {marker.label}
      </Text>
      <YStack width={2} height={10} borderRadius={1} backgroundColor="$color" opacity={0.7} marginTop={1} />
    </YStack>
  );
}
