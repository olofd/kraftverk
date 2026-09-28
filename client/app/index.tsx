import { useEffect, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, DeviceCard, Row, RowSeparator, SectionLabel, haptic } from '@kraftverk/ui';
import { fetchFound, type DeviceView, type FoundView } from '@kraftverk/api-client';

import { Pressable } from '../src/components/Pressable';
import { Screen } from '../src/components/Screen';
import { DeviceIcon } from '../src/features/devices/panels';
import { useDevices } from '../src/state/DevicesProvider';

/**
 * Everything you have, in one list. The app opens here, always.
 *
 * Nothing here is station-shaped or plug-shaped: a device is a name, an icon,
 * some measurements and some readings, and the card renders those. Services —
 * a weather forecast — sit in a section of their own. Above them, what the
 * server can see that you have not added yet.
 */
export default function DevicesScreen() {
  const { devices, removed, mode, loading, error } = useDevices();
  const theme = useTheme();
  const hardware = devices.filter((device) => device.kind === 'hardware');
  const services = devices.filter((device) => device.kind === 'service');

  const subtitle =
    mode === 'local'
      ? 'Local mode: this app holds every connection'
      : devices.length === 0
        ? undefined
        : devices.length === 1
          ? '1 device'
          : `${devices.length} devices`;

  return (
    <Screen title="Your devices" subtitle={subtitle}>
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger" lineHeight={19}>
            {error}
          </Text>
        </Card>
      ) : null}

      {mode === 'server' ? <FoundNearYou /> : null}

      {loading && devices.length === 0 ? (
        <Card>
          <YStack padding="$5" alignItems="center">
            <Spinner color="$accent" />
          </YStack>
        </Card>
      ) : null}

      {!loading && devices.length === 0 ? (
        <Card gap="$3" alignItems="flex-start">
          <YStack gap="$2">
            <Text fontSize={15} fontWeight="700" color="$color">
              You have not added anything yet
            </Text>
            <Text fontSize={13} color="$muted" lineHeight={19}>
              {mode === 'local'
                ? 'This app keeps its own devices and reaches them itself, over its own Bluetooth. Add a server in App settings for history and anything that runs while the app is closed.'
                : 'Add your first device to monitor it, configure it, and later connect it to automations.'}
            </Text>
          </YStack>
          <Button
            size="$3"
            backgroundColor="$accent"
            color="$background"
            icon={<Feather name="plus" size={14} color={theme.background?.val} />}
            onPress={() => {
              haptic();
              router.push('/add-device');
            }}
          >
            Add a device
          </Button>
        </Card>
      ) : null}

      <DeviceList devices={hardware} />
      {services.length > 0 ? (
        <YStack gap="$3">
          <SectionLabel>Services</SectionLabel>
          <DeviceList devices={services} />
        </YStack>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>Manage</SectionLabel>
        <Card inset>
          <Pressable onPress={() => router.push('/add-device')}>
            <Row
              title="Add a device"
              subtitle="A power station, a smart plug, a weather forecast"
              accessory={<Feather name="plus" size={16} color={theme.muted?.val} />}
            />
          </Pressable>
          {removed.length > 0 ? (
            <>
              <RowSeparator />
              <Pressable onPress={() => router.push('/removed')}>
                <Row
                  title="Removed devices"
                  subtitle={`${removed.length} kept with their history, to bring back or delete`}
                  accessory={<Feather name="chevron-right" size={16} color={theme.muted?.val} />}
                />
              </Pressable>
            </>
          ) : null}
          <RowSeparator />
          <Pressable onPress={() => router.push('/app-settings')}>
            <Row
              title="App settings"
              subtitle={mode === 'local' ? 'Servers, and what this app may do' : 'Accounts, transports, servers and this install'}
              accessory={<Feather name="chevron-right" size={16} color={theme.muted?.val} />}
            />
          </Pressable>
        </Card>
      </YStack>
    </Screen>
  );
}

function DeviceList({ devices }: { devices: DeviceView[] }) {
  return (
    <>
      {devices.map((device) => (
        <DeviceCard
          key={device.id}
          device={{ ...device, description: device.meta.name }}
          icon={<DeviceIcon device={device} />}
          onPress={() => router.push(`/device/${encodeURIComponent(device.id)}`)}
        />
      ))}
    </>
  );
}

/**
 * What the server's transports can see that nothing you have is reached by:
 * a station that connected to its broker, a plug broadcasting on the network.
 * Choosing one skips straight to checking it.
 */
function FoundNearYou() {
  const [found, setFound] = useState<FoundView[]>([]);
  const theme = useTheme();

  useEffect(() => {
    let live = true;
    const load = () =>
      fetchFound()
        .then((next) => live && setFound(next))
        .catch(() => undefined);
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (found.length === 0) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>Found near you</SectionLabel>
      <Card inset>
        {found.map((entry, index) => {
          const first = entry.types[0]!;
          return (
            <YStack key={`${entry.transport}-${entry.address}`}>
              {index > 0 ? <RowSeparator /> : null}
              <Pressable
                onPress={() =>
                  router.push(
                    `/add-device?type=${encodeURIComponent(first.typeId)}&method=${encodeURIComponent(first.methodId)}&address=${encodeURIComponent(entry.address)}`
                  )
                }
              >
                <Row
                  title={entry.name}
                  subtitle={`${first.name}${entry.types.length > 1 ? ` or ${entry.types.length - 1} more` : ''} · ${entry.detail ?? entry.address}`}
                  accessory={<Feather name="plus" size={16} color={theme.accent?.val} />}
                />
              </Pressable>
            </YStack>
          );
        })}
      </Card>
    </YStack>
  );
}
