import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, DeviceCard, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';
import type { DeviceView } from '@kraftverk/api-client';

import { Screen } from '../../src/components/Screen';
import { featherName } from '../../src/lib/icons';
import { useDevices } from '../../src/state/DevicesProvider';
import { useStation } from '../../src/state/StationProvider';

/**
 * Everything you own, in one list.
 *
 * There is nothing station-shaped in this file, and nothing plug-shaped either.
 * A device is a name, an icon, some measurements and some readings; the card
 * renders those, and the screen renders the cards. That is the whole payoff of
 * the device model — adding the plug is a row here, not a feature.
 */
export default function DevicesScreen() {
  const { devices, station, editable, loading, error } = useDevices();
  const { source } = useStation();
  const theme = useTheme();

  const subtitle = editable
    ? devices.length === 1
      ? '1 device'
      : `${devices.length} devices`
    : 'This app is holding the link itself';

  return (
    <Screen title="Devices" subtitle={subtitle}>
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger" lineHeight={19}>
            {error}
          </Text>
        </Card>
      ) : null}

      {loading && devices.length === 0 ? (
        <Card>
          <YStack padding="$5" alignItems="center">
            <Spinner color="$accent" />
          </YStack>
        </Card>
      ) : null}

      {!loading && devices.length === 0 ? (
        <Card gap="$2">
          <Text fontSize={15} fontWeight="700" color="$color">
            Nothing added yet
          </Text>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {source === 'direct'
              ? 'Connect to a station from the link screen and it will appear here.'
              : 'Add your power station, then anything else a driver can reach.'}
          </Text>
        </Card>
      ) : null}

      {devices.map((device) => (
        <DeviceCard
          key={device.id}
          device={device}
          icon={
            <Feather
              name={featherName(device.icon, 'zap')}
              size={16}
              color={device.online ? theme.accent?.val : theme.muted?.val}
            />
          }
          onPress={() => router.push(`/device/${encodeURIComponent(device.id)}`)}
        />
      ))}

      <YStack gap="$2">
        <SectionLabel>Manage</SectionLabel>
        <Card inset>
          {editable ? (
            <>
              <Pressable onPress={() => router.push('/add-device')}>
                <Row
                  title="Add a device"
                  subtitle="A power station, or anything an installed extension can reach"
                  accessory={<Feather name="plus" size={16} color={theme.muted?.val} />}
                />
              </Pressable>
              <RowSeparator />
            </>
          ) : null}
          <Pressable onPress={() => router.push('/link')}>
            <Row
              title="Station link"
              subtitle={linkSubtitle(source, station)}
              accessory={<Feather name="chevron-right" size={16} color={theme.muted?.val} />}
            />
          </Pressable>
        </Card>
      </YStack>
    </Screen>
  );
}

/** What the link row says under it: how we reach the station, in one line. */
function linkSubtitle(source: 'server' | 'direct', station: DeviceView | null): string {
  if (source === 'direct') return 'This app holds the station’s Bluetooth connection';
  if (!station) return 'How the server reaches your power station';
  const transport = station.record.config.transport;
  return transport === 'ble'
    ? 'The server holds it over Bluetooth'
    : transport === 'mqtt'
      ? 'The server holds it over WiFi'
      : 'Running against the simulator';
}

/** Tamagui's press styling on a plain wrapper, so a Row can be tapped. */
function Pressable({ onPress, children }: { onPress: () => void; children: React.ReactNode }) {
  return (
    <XStack pressStyle={{ opacity: 0.6 }} onPress={onPress}>
      <YStack flex={1}>{children}</YStack>
    </XStack>
  );
}
