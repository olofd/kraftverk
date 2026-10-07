import { router } from 'expo-router';
import { Text, useTheme } from 'tamagui';

import { Card, Row, RowSeparator, Icon } from '@kraftverk/ui';
import { PATHS } from '@kraftverk/api-client';

import { Pressable } from '../../components/Pressable';
import { Screen } from '../../components/Screen';
import { useDevices } from '../../state/DevicesProvider';

/**
 * Devices you removed, kept with their history. Adding one again brings its
 * history back; opening one shows it, and deletes it for good if you ask.
 */
export function RemovedScreen() {
  const { removed } = useDevices();
  const theme = useTheme();

  return (
    <Screen back="Your devices" title="Removed devices" subtitle="Kept with their history">
      <Card inset>
        {removed.length === 0 ? (
          <Row title="Nothing removed" subtitle="A device you remove is kept here with its history" />
        ) : (
          removed.map((device, index) => (
            <Pressable key={device.id} onPress={() => router.push(PATHS.devices.one(device.id))}>
              {index > 0 ? <RowSeparator /> : null}
              <Row
                title={device.name}
                subtitle={`${device.meta.name} · removed ${device.removedAt ? new Date(device.removedAt).toLocaleDateString() : ''}`}
                accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
              />
            </Pressable>
          ))
        )}
      </Card>
      <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
        Adding the same device again recognises it by its own id, and offers to bring its history back.
      </Text>
    </Screen>
  );
}
