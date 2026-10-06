import { Text, YStack } from 'tamagui';

import { byPlatform, whereTheyRun, type Need, type DeviceTypeListing } from '@kraftverk/api-client';
import type { CategorySpec, Platform } from '@kraftverk/device-sdk';
import { Card, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { DeviceImage } from '../../components/DeviceImage';
import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { useAnswer } from '../../components/useAnswer';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';

const SUPPORT: Record<string, string> = {
  verified: 'Verified on real hardware',
  community: 'Reported working by others',
  experimental: 'Experimental',
};

/** Where a node runs, as a person says it. */
const ON: Record<Platform, string> = { system: 'on a server', web: 'in a browser', native: 'on a phone' };

/** What a node must be, as a person says it. */
const MUST_BE: Record<Need['trait'], string> = { alwaysOn: 'always on', reachable: 'reachable by your other nodes', trusted: 'trusted to keep it' };

const listed = (words: readonly string[]): string => (words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

/** Where a platform's types run, in two sentences kept apart: the platforms, then what the node holding them must be, and why. */
function runs(types: readonly DeviceTypeListing[]): string {
  const { platforms, needs } = whereTheyRun(types);
  if (!platforms.length) return 'Nothing installed on it yet';
  const where = `Runs ${listed(platforms.map((platform) => ON[platform]))}.`;
  const must = needs.map((need) => `Held by a node that is ${MUST_BE[need.trait]}: ${need.why.join('; ')}.`);
  return [where, ...must].join(' ');
}

function TypeRow({ type, categories, devices }: { type: DeviceTypeListing; categories: Record<string, CategorySpec>; devices: number }) {
  const detail = [
    type.meta.brand ?? null,
    categories[type.meta.category]?.label ?? null,
    type.source.product ? null : type.kind === 'service' ? 'Its service' : 'For one nobody has described yet',
    SUPPORT[type.meta.support] ?? null,
    devices ? `${devices} of yours` : null,
  ];
  return <Row leading={<DeviceImage typeId={type.id} size={36} />} title={type.meta.name} subtitle={detail.filter(Boolean).join(' · ')} />;
}

/**
 * What this kraftverk can reach, by platform (docs/PLAN-INTEGRATIONS.md §1):
 * each integration, where it runs and what its node must be, and the
 * products known on it — each with how many of yours are one.
 */
export function Integrations() {
  const { api } = useHome();
  const { devices } = useDevices();
  const { value: list, error } = useAnswer(() => api.deviceTypes(), [api], { failure: 'What is installed could not be read' });
  const platforms = list ? byPlatform(list) : [];
  const yours = (typeId: string) => devices.filter((device) => device.typeId === typeId).length;

  return (
    <Screen back="App settings" backTo="/app-settings" title="Integrations" subtitle="The platforms kraftverk reaches, and the products it knows on each">
      {error ? <ErrorText>{error}</ErrorText> : null}
      {platforms.map(({ integration, products, own }) => (
        <YStack key={integration.id} gap="$2">
          <SectionLabel>{integration.name}</SectionLabel>
          <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
            {runs([...products, ...own])}
          </Text>
          <Card inset>
            {[...products, ...own].map((type, index) => (
              <YStack key={type.id}>
                {index > 0 ? <RowSeparator /> : null}
                <TypeRow type={type} categories={list?.categories ?? {}} devices={yours(type.id)} />
              </YStack>
            ))}
          </Card>
        </YStack>
      ))}
    </Screen>
  );
}
