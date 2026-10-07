import { router } from 'expo-router';
import { useTheme, YStack } from 'tamagui';

import { PATHS, type DeviceView } from '@kraftverk/api-client';
import { Card, Icon, Row, SectionLabel } from '@kraftverk/ui';

import { Pressable } from '../../components/Pressable';
import { screensFor } from './registry';

/** A device type's own tools, for the types that have any: drawn from their declarations, with a package's workbench above them. */
export function Tools({ device }: { device: DeviceView }) {
  const theme = useTheme();
  const workbench = screensFor(device)?.tools;
  if (!workbench && device.tools.length === 0) return null;
  const names = device.tools.map((tool) => tool.label).join(', ');
  return (
    <YStack gap="$2">
      <SectionLabel>Tools</SectionLabel>
      <Card inset>
        <Pressable onPress={() => router.push(PATHS.devices.tools(device.id))}>
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
