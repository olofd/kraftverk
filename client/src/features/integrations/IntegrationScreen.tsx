import { router, useLocalSearchParams } from 'expo-router';
import { Text, useTheme, YStack } from 'tamagui';

import { byPlatform, type DeviceTypeListing, type DeviceView, pathOf, PATHS, whereTheyRunSaid } from '@kraftverk/api-client';
import type { CategorySpec } from '@kraftverk/device-sdk';
import { Card, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { DeviceImage } from '../../components/DeviceImage';
import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { Screen } from '../../components/Screen';
import { useAnswer } from '../../components/useAnswer';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';
import { integrationScreens } from './registry';

const SUPPORT: Record<string, string> = {
  verified: 'Verified on real hardware',
  community: 'Reported working by others',
  experimental: 'Experimental',
};

function TypeRow({ type, categories, devices }: { type: DeviceTypeListing; categories: Record<string, CategorySpec>; devices: number }) {
  const detail = [
    type.meta.brand ?? null,
    categories[type.meta.category]?.label ?? null,
    type.source.product ? null : type.kind === 'service' ? 'Its service' : type.kind === 'account' ? 'Its account' : type.kind === 'gateway' ? 'Its gateway' : 'For one nobody has described yet',
    SUPPORT[type.meta.support] ?? null,
    devices ? `${devices} of yours` : null,
  ];
  return <Row leading={<DeviceImage typeId={type.id} size={36} />} title={type.meta.name} subtitle={detail.filter(Boolean).join(' · ')} />;
}

/** A device of yours on it, as a row: an account to its own page, a device to its device page. */
function YoursRow({ device, integration }: { device: DeviceView; integration: string }) {
  const theme = useTheme();
  const path = pathOf(device);
  return (
    <Pressable onPress={() => router.push(path)}>
      <Row
        leading={<DeviceImage typeId={device.typeId} size={36} />}
        title={device.name}
        subtitle={[device.meta.name, device.health.detail].filter(Boolean).join(' · ')}
        accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />}
      />
    </Pressable>
  );
}

/** What an integration's own kind is called on its page, and what adding one does. */
const OWN = {
  account: { label: 'Accounts', word: 'account', adds: 'Signed in once: what is on it is found, each added as a device of its own' },
  gateway: { label: 'Gateways', word: 'gateway', adds: 'Set up once: the devices behind it are found, each added as a device of its own' },
} as const;

/** An integration's own of one kind — its accounts, or its gateways: yours, each to its page, and another added from here. */
function OwnSection({ kind, yours, types, integration }: { kind: keyof typeof OWN; yours: DeviceView[]; types: DeviceTypeListing[]; integration: string }) {
  const theme = useTheme();
  if (!types.length && !yours.length) return null;
  return (
    <YStack gap="$2">
      <SectionLabel>{OWN[kind].label}</SectionLabel>
      <Card inset>
        {yours.map((device, index) => (
          <YStack key={device.id}>
            {index > 0 ? <RowSeparator /> : null}
            <YoursRow device={device} integration={integration} />
          </YStack>
        ))}
        {types.map((type, index) => (
          <YStack key={type.id}>
            {yours.length + index > 0 ? <RowSeparator /> : null}
            <Pressable onPress={() => router.push(PATHS.add(type.id))}>
              <Row title={`Add ${yours.length ? 'another' : 'your'} ${type.meta.name}`} subtitle={OWN[kind].adds} accessory={<Icon name="plus" size={16} color={theme.accent?.val} />} />
            </Pressable>
          </YStack>
        ))}
      </Card>
    </YStack>
  );
}

/** Yours on it, of one sort — devices, or services — each to its page. */
function YoursSection({ label, yours, integration }: { label: string; yours: DeviceView[]; integration: string }) {
  if (!yours.length) return null;
  return (
    <YStack gap="$2">
      <SectionLabel>{label}</SectionLabel>
      <Card inset>
        {yours.map((device, index) => (
          <YStack key={device.id}>
            {index > 0 ? <RowSeparator /> : null}
            <YoursRow device={device} integration={integration} />
          </YStack>
        ))}
      </Card>
    </YStack>
  );
}

/**
 * One integration's page (docs/PLAN-INTEGRATIONS.md §1.1): where it runs;
 * its own — your accounts on it, each to its own page where it is signed into
 * again, and its gateways — each added from here; its own screens; the
 * devices and the services you have on it; and every kind of thing it knows.
 */
export function IntegrationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useHome();
  const { devices } = useDevices();
  const { value: list, error } = useAnswer(() => api.deviceTypes(), [api], { failure: 'What is installed could not be read' });
  const platform = list ? (byPlatform(list).find((each) => each.integration.id === id) ?? null) : null;
  const on = devices.filter((device) => device.integration?.id === id && !device.removedAt);
  const accounts = on.filter((device) => device.kind === 'account');
  const ownOfKind = (kind: DeviceView['kind']) => platform?.own.filter((type) => type.kind === kind) ?? [];
  const types = platform ? [...platform.products, ...platform.own] : [];
  const yours = (typeId: string) => on.filter((device) => device.typeId === typeId).length;
  const Page = platform ? integrationScreens(platform.integration.id)?.page : undefined;

  return (
    <Screen back="Integrations" backTo={PATHS.integrations.list} title={platform?.integration.name ?? 'Integration'} subtitle={platform ? whereTheyRunSaid(types) : undefined}>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {list && !platform ? (
        <Card>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            No integration here is called “{id}”: it may no longer be installed.
          </Text>
        </Card>
      ) : null}

      {platform ? <OwnSection kind="account" yours={accounts} types={ownOfKind('account')} integration={platform.integration.id} /> : null}
      {platform ? <OwnSection kind="gateway" yours={on.filter((device) => device.kind === 'gateway')} types={ownOfKind('gateway')} integration={platform.integration.id} /> : null}

      {platform && Page ? <Page integration={platform.integration} accounts={accounts} /> : null}

      {platform ? <YoursSection label="Your devices on it" yours={on.filter((device) => device.kind === 'hardware')} integration={platform.integration.id} /> : null}
      {platform ? <YoursSection label="Your services on it" yours={on.filter((device) => device.kind === 'service')} integration={platform.integration.id} /> : null}

      {platform ? (
        <YStack gap="$2">
          <SectionLabel>What it knows</SectionLabel>
          <Card inset>
            {types.map((type, index) => (
              <YStack key={type.id}>
                {index > 0 ? <RowSeparator /> : null}
                <TypeRow type={type} categories={list?.categories ?? {}} devices={yours(type.id)} />
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}
    </Screen>
  );
}
