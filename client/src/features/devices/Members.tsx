import { router } from 'expo-router';
import { useTheme, YStack } from 'tamagui';

import type { DeviceView } from '@kraftverk/api-client';
import { Card, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { DeviceImage } from '../../components/DeviceImage';
import { Pressable } from '../../components/Pressable';
import { useAnswer } from '../../components/useAnswer';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';

/**
 * What is reached through a device — an account's scooters, a gateway's
 * plugs (docs/PLAN-INTEGRATIONS.md §4.3): the ones you have, and those it has
 * behind it that you have not added, each a tap from being added. Nothing for
 * a device nothing is reached through.
 */
export function Members({ device }: { device: DeviceView }) {
  const { devices } = useDevices();
  const { api } = useHome();
  const theme = useTheme();
  const yours = devices.filter((other) => other.connections.some((connection) => connection.through?.id === device.id));
  const found = (useAnswer(() => api.nearby(), [api, device.id], { every: 15_000 }).value ?? []).filter((entry) => entry.through?.id === device.id && !entry.ignored);
  if (!yours.length && !found.length) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>Through it</SectionLabel>
      <Card inset>
        {yours.map((member, index) => (
          <YStack key={member.id}>
            {index > 0 ? <RowSeparator /> : null}
            <Pressable onPress={() => router.push(`/device/${encodeURIComponent(member.id)}`)}>
              <Row leading={<DeviceImage typeId={member.typeId} size={36} />} title={member.name} subtitle={member.meta.name} accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />} />
            </Pressable>
          </YStack>
        ))}
        {found.map((entry, index) => {
          const first = entry.types[0]!;
          return (
            <YStack key={`found-${entry.address}`}>
              {yours.length + index > 0 ? <RowSeparator /> : null}
              <Pressable
                onPress={() =>
                  router.push(
                    `/add-device?type=${encodeURIComponent(first.typeId)}&method=${encodeURIComponent(first.methodId)}&address=${encodeURIComponent(entry.address)}&through=${encodeURIComponent(device.id)}`
                  )
                }
              >
                <Row
                  leading={<DeviceImage typeId={first.typeId} size={36} />}
                  title={entry.name}
                  subtitle={`Not added yet · ${first.name}`}
                  accessory={<Icon name="plus" size={16} color={theme.accent?.val} />}
                />
              </Pressable>
            </YStack>
          );
        })}
      </Card>
    </YStack>
  );
}
