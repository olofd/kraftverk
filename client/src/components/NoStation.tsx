import { router } from 'expo-router';
import { Button, Text, YStack } from 'tamagui';

import { Card, haptic } from '@kraftverk/ui';

import { useDevices } from '../state/DevicesProvider';
import { useStation } from '../state/StationProvider';

/**
 * What the station's screens show when there is no station.
 *
 * Worth a component rather than a shrug. Three different things can be true —
 * nothing has been added, the app is holding a link it has not connected yet,
 * or the server cannot be reached — and each one has a different next step. A
 * blank dashboard would say none of them.
 */
export function NoStation() {
  const { editable, loading, error } = useDevices();
  const { source, connection } = useStation();

  if (loading) return null;

  const direct = source === 'direct';
  const unreachable = editable && Boolean(error);

  const title = unreachable
    ? 'The server is not answering'
    : direct
      ? connection === 'connecting'
        ? 'Connecting to a station'
        : 'No station connected'
      : 'No station added yet';

  const body = unreachable
    ? error
    : direct
      ? 'This app is holding the Bluetooth link itself. Choose a station and its dashboard appears here.'
      : 'Add your power station and this becomes its dashboard. Everything else you add gets a card on the Devices screen.';

  return (
    <Card gap="$3">
      <YStack gap="$2">
        <Text fontSize={16} fontWeight="700" color="$color">
          {title}
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          {body}
        </Text>
      </YStack>

      {unreachable ? null : (
        <Button
          size="$3"
          backgroundColor="$accent"
          color="$background"
          onPress={() => {
            haptic();
            router.push(direct ? '/link' : '/add-device');
          }}
        >
          {direct ? 'Choose a station' : 'Add a power station'}
        </Button>
      )}
    </Card>
  );
}
