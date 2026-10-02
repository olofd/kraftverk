import { router, useLocalSearchParams } from 'expo-router';
import { Card, InfoCard, Row, SectionLabel, Icon } from '@kraftverk/ui';
import { Text, useTheme, XStack, YStack } from 'tamagui';

import type { DeviceView } from '@kraftverk/api-client';

import { Pressable } from '../../../src/components/Pressable';
import { DeviceConfig } from '../../../src/features/config/DeviceConfig';
import { DeviceShell } from '../../../src/features/devices/DeviceShell';
import { Connections, GenericSettings, Links, Manage } from '../../../src/features/devices/panels';
import { RemovedDevice } from '../../../src/features/devices/removed';
import { screensFor } from '../../../src/devices/ui';
import { HERE, HERE_PLATFORM } from '../../../src/platform/here';
import { useDevices } from '../../../src/state/DevicesProvider';
import { useHome } from '../../../src/state/HomeProvider';

/**
 * What this device remembers, how it is reached, how it fits the house, what
 * it is, and whether you still have it — in the order they matter.
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
      <InfoCard info={device.info} />
      <Tools device={device} />
      <DeviceConfig device={device} />
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
  const { screenProps, holderOf } = useDevices();
  const { role } = useHome();
  const { readOnly } = screenProps(device);
  // Which holder is this screen's business, not a device package's: the app says where writes go.
  const holder = holderOf(device);
  const theme = useTheme();
  const [tone, icon, message] = readOnly
    ? (['$warning', 'lock', holder === 'this-node' || role === 'master' ? 'Read-only: writes from this app are off (App settings).' : 'Read-only: the server refuses every write.'] as const)
    : holder === 'this-node'
      ? (['$muted', 'smartphone', `Written to ${device.name} from this app.`] as const)
      : holder === 'master'
        ? role === 'follower'
          ? (['$muted', 'server', `Written to ${device.name} through your server.`] as const)
          : (['$muted', HERE_PLATFORM === 'web' ? 'monitor' : 'smartphone', `Written to ${device.name} from ${HERE}.`] as const)
        : (['$muted', 'link-2', device.health.detail] as const);

  return (
    <XStack alignItems="center" gap="$2.5" paddingHorizontal="$1">
      <Icon name={icon} size={13} color={theme[tone]?.val ?? theme.muted?.val} />
      <Text fontSize={12} color={tone} lineHeight={17} flex={1}>
        {message}
      </Text>
    </XStack>
  );
}

/** A device type's own tools, for the types that have any: drawn from their declarations, with a package's workbench above them. */
function Tools({ device }: { device: DeviceView }) {
  const theme = useTheme();
  const workbench = screensFor(device)?.tools;
  if (!workbench && device.tools.length === 0) return null;
  const names = device.tools.map((tool) => tool.label).join(', ');
  return (
    <YStack gap="$2">
      <SectionLabel>Tools</SectionLabel>
      <Card inset>
        <Pressable onPress={() => router.push(`/device/${encodeURIComponent(device.id)}/tools`)}>
          <Row
            title={workbench?.label ?? 'Tools'}
            subtitle={workbench?.description ?? names}
            accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
          />
        </Pressable>
      </Card>
    </YStack>
  );
}
