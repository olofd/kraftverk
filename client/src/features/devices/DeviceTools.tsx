import { useLocalSearchParams } from 'expo-router';
import { Card, SectionLabel, ToolPanel } from '@kraftverk/ui';
import { Text, YStack } from 'tamagui';

import { Screen } from '../../components/Screen';
import { deviceStatus } from './DeviceShell';
import { screensFor } from './registry';
import { useDevice, useDevices } from '../../state/DevicesProvider';

/**
 * One device's tools, drawn from their declarations: what each asks for, a
 * run button, and what it answered — for any device whose type has tools,
 * with no screen of its own. A package may put a workbench of its own above
 * them (the station's register diff); the tools are there either way.
 */
export function DeviceTools() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const device = useDevice(id);
  const { screenProps } = useDevices();
  const settingsPath = device ? `/device/${encodeURIComponent(device.id)}/settings` : '/';

  if (!device) {
    return (
      <Screen back="Settings" backTo={settingsPath} title="Tools">
        <Card padding="$4">
          <Text fontSize={13} color="$muted" lineHeight={19}>
            That device is no longer in the list.
          </Text>
        </Card>
      </Screen>
    );
  }

  const props = screenProps(device);
  const workbench = screensFor(device)?.tools;
  const why = (writes: boolean) => (!props.reach.now ? props.reach.waiting : writes && props.readOnly ? 'Writes are off: this tool changes the device.' : undefined);

  return (
    <Screen back="Settings" backTo={settingsPath} title="Tools" subtitle={device.name} status={deviceStatus(device)}>
      {workbench ? (
        <YStack gap="$2">
          <SectionLabel>{workbench.label}</SectionLabel>
          <workbench.Screen {...props} />
        </YStack>
      ) : null}
      {device.tools.length ? (
        <YStack gap="$2">
          <SectionLabel>{workbench ? 'Every tool' : `${device.meta.name}'s tools`}</SectionLabel>
          {device.tools.map((tool) => (
            <ToolPanel key={tool.name} tool={tool} run={(input) => props.actions.tool(tool.name, input)} disabled={why(tool.writes) !== undefined} why={why(tool.writes)} />
          ))}
        </YStack>
      ) : workbench ? null : (
        <Card padding="$4">
          <Text fontSize={13} color="$muted" lineHeight={19}>
            This device has no tools.
          </Text>
        </Card>
      )}
    </Screen>
  );
}
