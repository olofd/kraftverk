import { Text, YStack } from 'tamagui';

import type { MapViewProps } from './props.ts';

/*
  A map, on a phone. MapLibre's native map needs the app's development
  build (docs/RUNNING.md), as Bluetooth does, and is not there yet: until it
  is, the place is said in words where the map would be — the same props,
  so screens draw `MapView` alike on every platform (docs/PLAN-MAPS.md).
*/

export function MapView({ markers = [], height = 200, label }: MapViewProps) {
  const first = markers[0];
  return (
    <YStack height={height} borderRadius="$4" backgroundColor="$backgroundPress" alignItems="center" justifyContent="center" padding="$4" gap="$1" aria-label={label}>
      <Text fontSize={13} color="$color" textAlign="center">
        {first ? `${first.latitude.toFixed(5)}°, ${first.longitude.toFixed(5)}°` : 'Nothing to show'}
      </Text>
      <Text fontSize={12} color="$muted" textAlign="center">
        The map is drawn in the web app; this app’s own map comes with its next build.
      </Text>
    </YStack>
  );
}
