import { router } from 'expo-router';
import { useTheme, XStack, YStack } from 'tamagui';

import { PATHS, type DeviceView } from '@kraftverk/api-client';
import { attributesOf, MAIN_PART, readingOf } from '@kraftverk/device-sdk';
import { Card, formatValue, HEALTH_DOT, Icon, isOld, observedAt, Row, RowSeparator, SectionLabel, shownAttributes } from '@kraftverk/ui';

import { DeviceImage } from '../../components/DeviceImage';
import { Pressable } from '../../components/Pressable';
import { useAnswer } from '../../components/useAnswer';
import { useDevices } from '../../state/DevicesProvider';
import { useFamily } from '../../state/FamilyProvider';

/**
 * A member at a glance: what it says now — "On · 12 W", "23.2 °C · 38 %",
 * an old value with when it was said — or, when it is not reached, why.
 */
function summaryOf(member: DeviceView): string {
  if (member.health.status !== 'connected') return member.health.detail;
  const said = shownAttributes(attributesOf(member.description, MAIN_PART)).flatMap((attribute) => {
    const reading = readingOf(member.readings, attribute.key);
    if (!reading || reading.value === null || typeof reading.value === 'object') return [];
    const text = formatValue(attribute, reading.value);
    return [isOld(attribute, reading) ? `${text} at ${observedAt(reading.at)}` : text];
  });
  return said.length ? said.slice(0, 3).join(' · ') : member.meta.name;
}

/**
 * What is reached through a device — an account's scooters, a gateway's
 * plugs (docs/PLAN-INTEGRATIONS.md §4.3): the ones you have, and those it has
 * behind it that you have not added, each a tap from being added. Nothing for
 * a device nothing is reached through.
 */
export function Members({ device, joiningUntil }: { device: DeviceView; /** Until when devices may join it, as the page knows it: looked at every few seconds until then. */ joiningUntil?: string | null }) {
  const { devices } = useDevices();
  const { api } = useFamily();
  const theme = useTheme();
  const yours = devices.filter((other) => other.connections.some((connection) => connection.through?.id === device.id));
  // Looked at often while devices may join it: one that joins shows up within seconds.
  const until = joiningUntil ?? device.joins?.until ?? null;
  const joining = Boolean(until && Date.parse(until) > Date.now());
  const found = (useAnswer(() => api.nearby(), [api, device.id, joining], { every: joining ? 3_000 : 15_000 }).value ?? []).filter((entry) => entry.through?.id === device.id && !entry.ignored);
  if (!yours.length && !found.length) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>Through it</SectionLabel>
      <Card inset>
        {yours.map((member, index) => (
          <YStack key={member.id}>
            {index > 0 ? <RowSeparator /> : null}
            <Pressable onPress={() => router.push(PATHS.devices.one(member.id))}>
              <Row
                leading={<DeviceImage typeId={member.typeId} size={36} />}
                title={member.name}
                subtitle={summaryOf(member)}
                accessory={
                  <XStack gap="$3" alignItems="center">
                    <YStack width={8} height={8} borderRadius={4} backgroundColor={HEALTH_DOT[member.health.status]} />
                    <Icon name="chevron-right" size={16} color={theme.muted?.val} />
                  </XStack>
                }
              />
            </Pressable>
          </YStack>
        ))}
        {/* One that does not say what it is is offered as each thing it could be: a person picks, rather than a first guess being made for them. */}
        {found
          .filter((entry) => entry.joining)
          .map((entry, index) => (
            <YStack key={`joining-${entry.address}`}>
              {yours.length + index > 0 ? <RowSeparator /> : null}
              <Row title={entry.name} subtitle={entry.about ? `Joining · ${entry.about}` : 'Joining: being asked what it is. Ready to add in a moment.'} accessory={<Icon name="loader" size={16} color={theme.muted?.val} />} />
            </YStack>
          ))}
        {found
          .filter((entry) => !entry.joining)
          .flatMap((entry) => entry.types.map((type) => ({ entry, type, several: entry.types.length > 1 })))
          .map(({ entry, type, several }, index) => (
            <YStack key={`found-${entry.address}-${type.typeId}`}>
              {yours.length + found.filter((other) => other.joining).length + index > 0 ? <RowSeparator /> : null}
              <Pressable onPress={() => router.push(PATHS.add(type.typeId, { method: type.methodId, address: entry.address, through: device.id }))}>
                <Row
                  leading={<DeviceImage typeId={type.typeId} size={36} />}
                  title={entry.name}
                  subtitle={[several ? `Not added yet · add it as a ${type.name}` : `Not added yet · ${type.name}`, entry.about].filter(Boolean).join(' · ')}
                  accessory={<Icon name="plus" size={16} color={theme.accent?.val} />}
                />
              </Pressable>
            </YStack>
          ))}
      </Card>
    </YStack>
  );
}
