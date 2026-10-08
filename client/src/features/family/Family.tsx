import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Spinner, Text, useTheme, YStack } from 'tamagui';

import { describeError, PATHS, type DeviceView, type HomeView, type PersonView, type PresenceView, type ZoneView } from '@kraftverk/api-client';
import { isPosition } from '@kraftverk/device-sdk';
import { Card, Icon, MapView, Row, RowSeparator, SectionLabel, useMapApi } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { Screen } from '../../components/Screen';
import { useDevices } from '../../state/DevicesProvider';
import { useFamily } from '../../state/FamilyProvider';
import { SHARING_SHORT } from '../account/SharingChoice';

/*
  Where everyone is (docs/PLAN-WORLD-MODEL.md §8.9, §11), as far as each
  shares: the family's homes and zones on a map, a dot for each person whose
  position is theirs to show — at precise, or your own — and each in words,
  "at Work since 08:40". A person's own page: where they are, what they share,
  and what they carry and own. Looked at again every half minute.
*/

/** How often the screen asks again: presence moves in minutes. */
const AGAIN_MS = 30_000;

type Everyone = { people: PersonView[]; presence: PresenceView[]; homes: HomeView[]; zones: ZoneView[] };

function useEveryone(): { everyone: Everyone | null; problem: string | null } {
  const { api } = useFamily();
  const [everyone, setEveryone] = useState<Everyone | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [people, presence, homes, zones] = await Promise.all([api.people.list(), api.presence.list(), api.homes.list(), api.zones.list()]);
      setEveryone({ people, presence, homes, zones });
      setProblem(null);
    } catch (err) {
      setProblem(describeError(err) || 'Where everyone is could not be read');
    }
  }, [api]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), AGAIN_MS);
    return () => clearInterval(timer);
  }, [load]);
  return { everyone, problem };
}

const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Where a person is, in words, as far as they share. */
function whereWords(presence: PresenceView | undefined, carriesAnything: boolean): string {
  if (!presence || presence.sharing === 'off') return 'Shares nothing of where they are';
  if (!carriesAnything) return 'Carries nothing that says where it is';
  if (presence.sharing === 'home-away') return presence.home ? 'At home' : 'Away';
  if (!presence.places.length) return 'Away: at none of the family’s places';
  const first = presence.places[0]!;
  return `At ${presence.places.map((place) => place.name).join(', ')} since ${clock(first.since)}`;
}

/** Where each device someone carries says it is — only those the family shows this reader. */
function positionsOf(devices: readonly DeviceView[]) {
  return devices.flatMap((device) => {
    const reading = device.people.carries ? device.readings.find((each) => isPosition(each.value)) : undefined;
    return reading && isPosition(reading.value) ? [{ device, carrier: device.people.carries!, position: reading.value }] : [];
  });
}

export function FamilyMap() {
  const { everyone, problem } = useEveryone();
  const { devices } = useDevices();
  const theme = useTheme();
  const mapApi = useMapApi();
  const located = positionsOf(devices);
  const carrying = new Set(devices.filter((device) => device.people.carries && device.description.attributes.some((attribute) => attribute.means === 'position')).map((device) => device.people.carries!));
  const chevron = <Icon name="chevron-right" size={16} color={theme.muted?.val} />;

  return (
    <Screen back="Your devices" backTo={PATHS.home} title="Where everyone is" subtitle="As far as each of you shares: never more">
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
      {!everyone && !problem ? <Spinner color="$accent" /> : null}
      {everyone && mapApi ? (
        <MapView
          label="Your family's homes and zones, and where those who share it are"
          height={280}
          zones={[
            ...everyone.homes.flatMap((home) => (home.location ? [{ id: home.id, ...home.location, label: home.name }] : [])),
            ...everyone.zones.map((zone) => ({ id: zone.id, ...zone.location, label: zone.name, color: '#8b5cf6' })),
          ]}
          markers={located.map(({ device, carrier, position }) => {
            const person = everyone.people.find((each) => each.id === carrier);
            return { id: device.id, latitude: position.latitude, longitude: position.longitude, accuracy: position.accuracy ?? null, label: person?.shownAs ?? device.name, color: person?.member?.color ?? undefined };
          })}
        />
      ) : null}
      {everyone ? (
        <YStack gap="$2">
          <SectionLabel>Your family</SectionLabel>
          <Card inset>
            {everyone.people.map((person, index) => (
              <YStack key={person.id}>
                {index ? <RowSeparator /> : null}
                <Pressable onPress={() => router.push(PATHS.family.person(person.id))}>
                  <Row
                    leading={<YStack width={14} height={14} borderRadius={7} backgroundColor={(person.member?.color ?? '$borderColor') as never} />}
                    title={person.shownAs}
                    subtitle={whereWords(
                      everyone.presence.find((each) => each.personId === person.id),
                      carrying.has(person.id)
                    )}
                    accessory={chevron}
                  />
                </Pressable>
              </YStack>
            ))}
          </Card>
          <Text fontSize={12} color="$muted" lineHeight={17} paddingHorizontal="$1">
            Each says what they share on People. Who carries a phone or a tag is said in its settings.
          </Text>
        </YStack>
      ) : null}
    </Screen>
  );
}

/** One person: where they are, what they share, and what they carry and own. */
export function PersonPage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { everyone, problem } = useEveryone();
  const { devices } = useDevices();
  const theme = useTheme();
  const person = everyone?.people.find((each) => each.id === id) ?? null;
  const presence = everyone?.presence.find((each) => each.personId === id);
  const carried = devices.filter((device) => device.people.carries === id);
  const owned = devices.filter((device) => device.people.owns.includes(id) && device.people.carries !== id);
  const chevron = <Icon name="chevron-right" size={16} color={theme.muted?.val} />;
  const deviceRows = (list: DeviceView[]) =>
    list.map((device, index) => (
      <YStack key={device.id}>
        {index ? <RowSeparator /> : null}
        <Pressable onPress={() => router.push(PATHS.devices.one(device.id))}>
          <Row title={device.name} subtitle={device.meta.name} accessory={chevron} />
        </Pressable>
      </YStack>
    ));

  return (
    <Screen back="Where everyone is" backTo={PATHS.family.list} title={person?.shownAs ?? 'Someone'} subtitle={person && person.member ? SHARING_SHORT[person.member.sharing.now] : undefined}>
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
      {!everyone && !problem ? <Spinner color="$accent" /> : null}
      {everyone && !person ? <ErrorText paddingHorizontal="$1">There is no such person in your family</ErrorText> : null}
      {person ? (
        <>
          <Card>
            <Text fontSize={16} fontWeight="600" color="$color">
              {whereWords(
                presence,
                carried.some((device) => device.description.attributes.some((attribute) => attribute.means === 'position'))
              )}
            </Text>
          </Card>
          {carried.length ? (
            <YStack gap="$2">
              <SectionLabel>Carries</SectionLabel>
              <Card inset>{deviceRows(carried)}</Card>
            </YStack>
          ) : null}
          {owned.length ? (
            <YStack gap="$2">
              <SectionLabel>Owns</SectionLabel>
              <Card inset>{deviceRows(owned)}</Card>
            </YStack>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
