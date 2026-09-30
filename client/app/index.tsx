import { useEffect, useState } from 'react';
import { router } from 'expo-router';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, DeviceCard, Row, RowSeparator, SectionLabel, haptic, Icon } from '@kraftverk/ui';
import { fetchFound, type DeviceView, type FoundView } from '@kraftverk/api-client';
import { attributesOf, CATEGORIES, MAIN_PART } from '@kraftverk/device-sdk';

import { DeviceImage } from '../src/components/DeviceImage';
import { Pressable } from '../src/components/Pressable';
import { pictureFor } from '../src/devices/ui';
import { Screen } from '../src/components/Screen';
import { DeviceIcon } from '../src/features/devices/panels';
import { useDevices } from '../src/state/DevicesProvider';

/** What can be added, from the categories something installed is in: "Power stations, smart plugs, weather". */
const addSubtitle = (installed: readonly { meta: { category: string } }[]) =>
  Object.entries(CATEGORIES)
    .filter(([id]) => installed.some((type) => type.meta.category === id))
    .map(([, category], index) => (index ? category.label.toLowerCase() : category.label))
    .join(', ');

/** The products installed here, by name: "Brand station, Brand plug and a weather service". */
const productList = (installed: readonly { meta: { name: string } }[]) => {
  const names = installed.map((type) => type.meta.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? 'nothing yet');
};

/**
 * Everything you have, in one list. The app opens here, always.
 *
 * Nothing here is station-shaped or plug-shaped: a device is a name, an icon,
 * some measurements and some readings, and the card renders those. Services —
 * a weather forecast — sit in a section of their own. Above them, what the
 * server can see that you have not added yet.
 */
export default function DevicesScreen() {
  const { devices, removed, mode, loading, error, runtime, problems, heard } = useDevices();
  const theme = useTheme();
  const installed = [...runtime.registry.types.values()];
  const [problemCount, setProblemCount] = useState<number | null>(null);

  // How many warnings and errors there are to look at, read again when the stream carries an event.
  useEffect(() => {
    if (!problems) return setProblemCount(null);
    const controller = new AbortController();
    void problems(100, controller.signal)
      .then((found) => setProblemCount(found.length))
      .catch(() => undefined);
    return () => controller.abort();
  }, [heard?.count, problems]);
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
                : `Add your first device to watch it, set it up and let automations use it. This install can add ${productList(installed)}.`}
            </Text>
          </YStack>
          <Button
            size="$3"
            backgroundColor="$accent"
            color="$background"
            icon={<Icon name="plus" size={14} color={theme.background?.val} />}
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
              subtitle={addSubtitle(installed)}
              accessory={<Icon name="plus" size={16} color={theme.muted?.val} />}
            />
          </Pressable>
          {mode === 'server' ? (
            <>
              <RowSeparator />
              <Pressable onPress={() => router.push('/automations')}>
                <Row
                  title="Automations"
                  subtitle="What happens on its own: “if tomorrow is sunny, turn the plug on”"
                  accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
                />
              </Pressable>
            </>
          ) : null}
          {problems ? (
            <>
              <RowSeparator />
              <Pressable onPress={() => router.push('/problems')}>
                <Row
                  title="Problems"
                  subtitle={problemCount ? `${problemCount} warning${problemCount === 1 ? '' : 's'} or error${problemCount === 1 ? '' : 's'} your devices reported` : 'None reported'}
                  accessory={<Icon name={problemCount ? 'alert-triangle' : 'chevron-right'} size={16} color={problemCount ? theme.warning?.val : theme.muted?.val} />}
                />
              </Pressable>
            </>
          ) : null}
          {removed.length > 0 ? (
            <>
              <RowSeparator />
              <Pressable onPress={() => router.push('/removed')}>
                <Row
                  title="Removed devices"
                  subtitle={`${removed.length} kept with their history, to bring back or delete`}
                  accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
                />
              </Pressable>
            </>
          ) : null}
          <RowSeparator />
          <Pressable onPress={() => router.push('/app-settings')}>
            <Row
              title="App settings"
              subtitle={mode === 'local' ? 'Servers, and what this app may do' : 'Accounts, connectivity, servers and this install'}
              accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
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
          device={{ name: device.name, subtitle: device.meta.name, health: device.health, attributes: attributesOf(device.description, MAIN_PART), readings: device.readings }}
          icon={<DeviceIcon device={device} />}
          image={pictureFor(device.typeId, device.picture)}
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
                  leading={
                    // Its picture only when it is known what it is: one model's picture on "one of several plugs" would be a guess drawn as a fact.
                    entry.types.length === 1 && pictureFor(first.typeId) ? (
                      <DeviceImage typeId={first.typeId} size={36} />
                    ) : (
                      <YStack width={36} height={36} alignItems="center" justifyContent="center">
                        <Icon name="help-circle" size={20} color={theme.muted?.val} />
                      </YStack>
                    )
                  }
                  title={entry.name}
                  subtitle={`${first.name}${entry.types.length > 1 ? ` or ${entry.types.length - 1} more` : ''} · ${entry.detail ?? entry.address}`}
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
