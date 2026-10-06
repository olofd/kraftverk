import { router } from 'expo-router';
import { Button, Spinner, Text, useTheme, YStack } from 'tamagui';

import type { DeviceTypeListing, DeviceView } from '@kraftverk/api-client';
import { attributesOf, CATEGORIES, MAIN_PART } from '@kraftverk/device-sdk';
import { Card, DeviceCard, haptic, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { Screen } from '../../components/Screen';
import { useAnswer } from '../../components/useAnswer';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';
import { useShowing } from '../../state/useShowing';
import { Shortcuts } from '../automations/Shortcuts';
import { DeviceIcon } from '../devices/DeviceIcon';
import { PROBLEMS_SHOWN } from '../devices/ProblemsScreen';
import { pictureFor } from '../devices/registry';
import { Elsewhere } from './Elsewhere';
import { FoundNearYou } from './FoundNearYou';
import { NeedsYou } from './NeedsYou';

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
 * home can see that you have not added yet.
 */
export function HomeScreen() {
  const { devices, removed, loading, error, heard } = useDevices();
  const { api, role } = useHome();
  const theme = useTheme();
  // What the home can add: the installed types, as it lists them.
  const installed: readonly DeviceTypeListing[] = useAnswer(() => api.deviceTypes(), [api]).value?.types ?? [];

  // How many warnings and errors there are to look at, read again when the stream carries an event.
  const problemCount = useAnswer(() => api.problems(PROBLEMS_SHOWN), [api, heard.count]).value?.length ?? null;
  const hardware = devices.filter((device) => device.kind === 'hardware');
  const services = devices.filter((device) => device.kind === 'service');
  // Accounts are not here: each is its integration's, managed on its page (docs/PLAN-INTEGRATIONS.md §1.1); what is reached through one is among the devices above.
  const accounts = devices.filter((device) => device.kind === 'account' && !device.removedAt).length;
  // Every device here shows its readings: while this page is in front, the home reads them more often.
  useShowing(devices.map((device) => ({ kind: 'device', id: device.id })));

  const subtitle =
    devices.length === 0
        ? undefined
        : devices.length === 1
          ? '1 device'
          : `${devices.length} devices`;

  return (
    <Screen title="Your devices" subtitle={subtitle}>
      {error ? (
        <Card borderColor="$danger">
          <ErrorText>
            {error}
          </ErrorText>
        </Card>
      ) : null}

      <Elsewhere />
      <Shortcuts />
      <NeedsYou />
      <FoundNearYou />

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
              {role === 'master'
                ? `This app keeps its own devices, their history and their automations, and reaches them itself — while it is open. Add a server in App settings for what runs while the app is closed. It can add ${productList(installed)}.`
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
          <RowSeparator />
          <Pressable onPress={() => router.push('/integrations')}>
            <Row
              title="Integrations"
              subtitle={accounts ? `Your ${accounts === 1 ? 'account' : `${accounts} accounts`} on the services kraftverk reaches, and what each knows` : 'The services and platforms kraftverk reaches: sign in to an account, and what is on it is found'}
              accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
            />
          </Pressable>
          <RowSeparator />
          <Pressable onPress={() => router.push('/automations')}>
            <Row
              title="Automations"
              subtitle="What runs on its own, and what you start: “if tomorrow is sunny, turn the plug on”, “start charging”"
              accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
            />
          </Pressable>
          <RowSeparator />
          <Pressable onPress={() => router.push('/problems')}>
            <Row
              title="Problems"
              subtitle={problemCount ? `${problemCount} warning${problemCount === 1 ? '' : 's'} or error${problemCount === 1 ? '' : 's'} your devices reported` : 'None reported'}
              accessory={<Icon name={problemCount ? 'alert-triangle' : 'chevron-right'} size={16} color={problemCount ? theme.warning?.val : theme.muted?.val} />}
            />
          </Pressable>
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
              subtitle={role === 'master' ? 'Servers, and what this app may do' : 'Accounts, connectivity, servers and this install'}
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
