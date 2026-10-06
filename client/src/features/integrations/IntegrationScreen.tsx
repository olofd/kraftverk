import { router, useLocalSearchParams } from 'expo-router';
import { Text, useTheme, YStack } from 'tamagui';

import { byPlatform, whereTheyRunSaid, type DeviceTypeListing, type DeviceView } from '@kraftverk/api-client';
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

/** Where an account's page is: under its integration, never among the devices (docs/PLAN-INTEGRATIONS.md §1.1). */
export const accountPath = (integration: string, account: string): string => `/integration/${encodeURIComponent(integration)}/account/${encodeURIComponent(account)}`;

const SUPPORT: Record<string, string> = {
  verified: 'Verified on real hardware',
  community: 'Reported working by others',
  experimental: 'Experimental',
};

function TypeRow({ type, categories, devices }: { type: DeviceTypeListing; categories: Record<string, CategorySpec>; devices: number }) {
  const detail = [
    type.meta.brand ?? null,
    categories[type.meta.category]?.label ?? null,
    type.source.product ? null : type.kind === 'service' ? 'Its service' : type.kind === 'account' ? 'Its account' : 'For one nobody has described yet',
    SUPPORT[type.meta.support] ?? null,
    devices ? `${devices} of yours` : null,
  ];
  return <Row leading={<DeviceImage typeId={type.id} size={36} />} title={type.meta.name} subtitle={detail.filter(Boolean).join(' · ')} />;
}

/** A device of yours on it, as a row: an account to its own page, a device to its device page. */
function YoursRow({ device, integration }: { device: DeviceView; integration: string }) {
  const theme = useTheme();
  const path = device.kind === 'account' ? accountPath(integration, device.id) : `/device/${encodeURIComponent(device.id)}`;
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

/**
 * One integration's page (docs/PLAN-INTEGRATIONS.md §1.1): where it runs;
 * your accounts on it — each to its own page, where it is signed into again —
 * and a new one added from here; its own screens; the devices you have on it;
 * and every kind of device it knows.
 */
export function IntegrationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useHome();
  const { devices } = useDevices();
  const theme = useTheme();
  const { value: list, error } = useAnswer(() => api.deviceTypes(), [api], { failure: 'What is installed could not be read' });
  const platform = list ? (byPlatform(list).find((each) => each.integration.id === id) ?? null) : null;
  const on = devices.filter((device) => device.integration?.id === id && !device.removedAt);
  const accounts = on.filter((device) => device.kind === 'account');
  const others = on.filter((device) => device.kind !== 'account');
  const accountTypes = platform?.own.filter((type) => type.kind === 'account') ?? [];
  const types = platform ? [...platform.products, ...platform.own] : [];
  const yours = (typeId: string) => on.filter((device) => device.typeId === typeId).length;
  const Page = platform ? integrationScreens(platform.integration.id)?.page : undefined;

  return (
    <Screen back="Integrations" backTo="/integrations" title={platform?.integration.name ?? 'Integration'} subtitle={platform ? whereTheyRunSaid(types) : undefined}>
      {error ? <ErrorText>{error}</ErrorText> : null}
      {list && !platform ? (
        <Card>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            No integration here is called “{id}”: it may no longer be installed.
          </Text>
        </Card>
      ) : null}

      {platform && accountTypes.length ? (
        <YStack gap="$2">
          <SectionLabel>Accounts</SectionLabel>
          <Card inset>
            {accounts.map((account, index) => (
              <YStack key={account.id}>
                {index > 0 ? <RowSeparator /> : null}
                <YoursRow device={account} integration={platform.integration.id} />
              </YStack>
            ))}
            {accountTypes.map((type, index) => (
              <YStack key={type.id}>
                {accounts.length + index > 0 ? <RowSeparator /> : null}
                <Pressable onPress={() => router.push(`/add-device?type=${encodeURIComponent(type.id)}`)}>
                  <Row title={`Add ${accounts.length ? 'another' : 'your'} ${type.meta.name}`} subtitle="Signed in once: what is on it is found, each added as a device of its own" accessory={<Icon name="plus" size={16} color={theme.accent?.val} />} />
                </Pressable>
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}

      {platform && Page ? <Page integration={platform.integration} accounts={accounts} /> : null}

      {platform && others.length ? (
        <YStack gap="$2">
          <SectionLabel>Your devices on it</SectionLabel>
          <Card inset>
            {others.map((device, index) => (
              <YStack key={device.id}>
                {index > 0 ? <RowSeparator /> : null}
                <YoursRow device={device} integration={platform.integration.id} />
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}

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
