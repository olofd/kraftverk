import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { Card, Row, SectionLabel } from '@kraftverk/ui';
import { Text, useTheme, XStack, YStack } from 'tamagui';

import type { DeviceView } from '@kraftverk/api-client';

import { Pressable } from '../../../src/components/Pressable';
import { DeviceShell } from '../../../src/features/devices/DeviceShell';
import { Connections, GenericSettings, Links, Manage } from '../../../src/features/devices/panels';
import { RemovedDevice } from '../../../src/features/devices/removed';
import { screensFor } from '../../../src/devices/ui';
import { useDevices } from '../../../src/state/DevicesProvider';

/**
 * What this device remembers, how it is reached, how it fits the house, and
 * whether you still have it — in the order they matter.
 */
export default function DeviceSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DeviceShell id={id} tab="settings">{(device) => (device.removedAt ? <RemovedDevice device={device} /> : <DeviceSettings device={device} />)}</DeviceShell>;
}

function DeviceSettings({ device }: { device: DeviceView }) {
  const { screenProps } = useDevices();
  const Panel = screensFor(device)?.settings;
  return (
    <>
      <WhereWritesGo device={device} />
      {Panel ? <Panel {...screenProps(device)} /> : <GenericSettings device={device} />}
      <Connections device={device} />
      <Links device={device} />
      <Advanced device={device} />
      <Manage device={device} />
    </>
  );
}

/**
 * Where the values on this screen go: the hardware, through whom — or nowhere,
 * while writes are refused. On a device where one wrong register permanently
 * bricks the machine, that is worth one line.
 */
function WhereWritesGo({ device }: { device: DeviceView }) {
  const { screenProps } = useDevices();
  const { holder, readOnly } = screenProps(device);
  const theme = useTheme();
  const [tone, icon, message] = readOnly
    ? (['$warning', 'lock', holder === 'this-app' ? 'Read-only: writes from this app are off (App settings).' : 'Read-only: the server refuses every write.'] as const)
    : holder === 'this-app'
      ? (['$muted', 'smartphone', `Written to ${device.name} from this app.`] as const)
      : holder === 'server'
        ? (['$muted', 'server', `Written to ${device.name} through your server.`] as const)
        : (['$muted', 'link-2', device.health.detail] as const);

  return (
    <XStack alignItems="center" gap="$2.5" paddingHorizontal="$1">
      <Feather name={icon} size={13} color={theme[tone]?.val ?? theme.muted?.val} />
      <Text fontSize={12} color={tone} lineHeight={17} flex={1}>
        {message}
      </Text>
    </XStack>
  );
}

/** A device type's own tools, for the types that have any. */
function Advanced({ device }: { device: DeviceView }) {
  const theme = useTheme();
  const advanced = screensFor(device)?.advanced;
  if (!advanced) return null;
  return (
    <YStack gap="$2">
      <SectionLabel>Advanced</SectionLabel>
      <Card inset>
        <Pressable onPress={() => router.push(`/device/${encodeURIComponent(device.id)}/advanced`)}>
          <Row
            title={advanced.label}
            subtitle={advanced.description}
            accessory={<Feather name="chevron-right" size={16} color={theme.muted?.val} />}
          />
        </Pressable>
      </Card>
    </YStack>
  );
}
