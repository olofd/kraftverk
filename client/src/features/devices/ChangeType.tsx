import { router } from 'expo-router';
import { useTheme, YStack } from 'tamagui';

import { PATHS, type DeviceView } from '@kraftverk/api-client';
import { Card, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { Pressable } from '../../components/Pressable';
import { useAnswer } from '../../components/useAnswer';
import { useDevices } from '../../state/DevicesProvider';
import { useFamily } from '../../state/FamilyProvider';

/**
 * What else a device could be (docs/PLAN-ZIGBEE.md §2.1): the other types
 * reached through the bridge it is behind — a Zigbee switch that turned out
 * to meter, offered as a plug. Choosing one sets it up as that type, and the
 * check offers the move: its history mapped, shown before anything moves.
 * Nothing for a device that is behind no bridge, or whose bridge reaches no
 * other type.
 */
export function ChangeType({ device }: { device: DeviceView }) {
  const { api } = useFamily();
  const { devices } = useDevices();
  const theme = useTheme();
  const types = useAnswer(() => api.deviceTypes().then((list) => list.types), [api]).value ?? [];
  const way = device.connections.find((connection) => connection.through);
  const bridge = way?.through ? devices.find((other) => other.id === way.through!.id) : null;
  if (!way || !bridge || device.removedAt) return null;

  const others = types.flatMap((type) => {
    if (type.id === device.typeId) return [];
    const method = type.connections.find((candidate) => 'through' in candidate && candidate.through?.includes(bridge.typeId));
    return method ? [{ type, method: method.id }] : [];
  });
  if (!others.length) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>Change what it is</SectionLabel>
      <Card inset>
        {others.map(({ type, method }, index) => (
          <YStack key={type.id}>
            {index > 0 ? <RowSeparator /> : null}
            <Pressable onPress={() => router.push(PATHS.add(type.id, { method, address: way.address, through: bridge.id }))}>
              <Row
                title={`Make it a ${type.meta.name}`}
                subtitle="Its history, links and automations come with it: what moves where is shown first"
                accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
              />
            </Pressable>
          </YStack>
        ))}
      </Card>
    </YStack>
  );
}
