import { useLocalSearchParams } from 'expo-router';
import { Card, Text } from 'tamagui';

import { Screen } from '../../../src/components/Screen';
import { useDeviceConnection } from '../../../src/features/devices/connection';
import { screensFor } from '../../../src/devices/screens';
import { useDevice } from '../../../src/state/DevicesProvider';
import { useDirectLink } from '../../../src/state/DirectLinkProvider';

/**
 * One device's advanced tools.
 *
 * The register map, the snapshot-and-diff workflow and everything it knows
 * about Sydpower framing belong to the device package. What is here is the
 * page, and the fact that it is *this* device's page: reached from its Settings
 * screen, under Advanced, rather than from a global tab that implied every
 * install has exactly one station worth diagnosing.
 */
export default function DeviceAdvancedScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const device = useDevice(id);
  const connection = useDeviceConnection(device);
  const { source, direct } = useDirectLink();

  const screens = screensFor(device);

  const settingsPath = device ? `/device/${encodeURIComponent(device.id)}/settings` : '/';

  if (!device || !screens?.protocol) {
    return (
      <Screen back="Settings" backTo={settingsPath} title="Advanced">
        <Card padding="$4">
          <Text fontSize={13} color="$muted" lineHeight={19}>
            This device has no advanced tools.
          </Text>
        </Card>
      </Screen>
    );
  }

  const Panel = screens.protocol;

  return (
    <Screen
      back="Settings"
      backTo={settingsPath}
      title="Protocol"
      subtitle={`Verify the register map against ${device.record.name}`}
    >
      <Panel
        status={connection.status}
        version={connection.version}
        source={source}
        direct={direct}
      />
    </Screen>
  );
}
