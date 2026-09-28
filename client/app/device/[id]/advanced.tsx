import { useLocalSearchParams } from 'expo-router';
import { Card, Text } from 'tamagui';

import { Screen } from '../../../src/components/Screen';
import { deviceStatus } from '../../../src/features/devices/DeviceShell';
import { screensFor } from '../../../src/devices/ui';
import { useDevice, useDevices } from '../../../src/state/DevicesProvider';

/**
 * One device's advanced tools: its type's own screen, reached from its
 * Settings. The page is the app's; what is on it is the device package's.
 */
export default function DeviceAdvancedScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const device = useDevice(id);
  const { screenProps } = useDevices();
  const Panel = screensFor(device)?.protocol;
  const settingsPath = device ? `/device/${encodeURIComponent(device.id)}/settings` : '/';

  if (!device || !Panel) {
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

  return (
    <Screen back="Settings" backTo={settingsPath} title="Protocol" subtitle={`Verify the register map against ${device.name}`} status={deviceStatus(device)}>
      <Panel {...screenProps(device)} />
    </Screen>
  );
}
