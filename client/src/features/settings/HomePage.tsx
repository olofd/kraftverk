import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Image } from 'react-native';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, PATHS, type HomeView } from '@kraftverk/api-client';
import { isTimeZone } from '@kraftverk/device-sdk';
import { Card, Chips, haptic, Row, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Screen } from '../../components/Screen';
import { confirmAction } from '../../platform/confirm';
import { pickPicture, usePicture } from '../../platform/picture';
import { useFamily } from '../../state/FamilyProvider';
import { HomeLocation } from './HomeLocation';
import { HOME_TYPES, homeLine } from './Homes';

/**
 * One home (docs/PLAN-WORLD-MODEL.md §8.4): its name and what it is, its
 * clock — what its automations keep time in — and where it is. Left, it is
 * archived: what was recorded there stays its own. Never the last.
 */
export function HomePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useFamily();
  const [home, setHome] = useState<HomeView | null>(null);
  const [count, setCount] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [zone, setZone] = useState('');

  const load = useCallback(async () => {
    try {
      const homes = await api.homes.list();
      const found = homes.find((each) => each.id === id) ?? null;
      setHome(found);
      setCount(homes.length);
      if (found) (setName(found.name), setZone(found.timeZone));
      setProblem(found ? null : 'There is no such home');
    } catch (err) {
      setProblem(describeError(err) || 'The home could not be read');
    }
  }, [api, id]);
  useEffect(() => void load(), [load]);

  const change = async (changes: Parameters<typeof api.homes.update>[1]) => {
    if (!home) return;
    haptic();
    setProblem(null);
    try {
      setHome(await api.homes.update(home.id, changes));
    } catch (err) {
      setProblem(describeError(err) || 'That could not be changed');
    }
  };

  const leave = async () => {
    if (!home) return;
    if (!(await confirmAction(`Leave ${home.name}?`, 'It goes from your homes. What was recorded there is kept, as it was.', 'Leave it', 'careful'))) return;
    try {
      await api.homes.remove(home.id);
      router.replace(PATHS.settings.homes);
    } catch (err) {
      setProblem(describeError(err) || 'It could not be left');
    }
  };

  const picture = usePicture(api, home?.pictureId ?? null);
  const [adding, setAdding] = useState(false);
  const addPicture = async () => {
    setProblem(null);
    setAdding(true);
    try {
      const picked = await pickPicture();
      if (picked) await change({ pictureId: (await api.media.add(picked)).id });
    } catch (err) {
      setProblem(describeError(err) || 'The picture could not be added');
    } finally {
      setAdding(false);
    }
  };

  const zoneValid = isTimeZone(zone.trim());
  return (
    <Screen back="Homes" backTo={PATHS.settings.homes} title={home?.name ?? 'A home'} subtitle={home ? homeLine(home) : undefined}>
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
      {!home && !problem ? <Spinner color="$accent" /> : null}
      {home ? (
        <>
          <YStack gap="$2">
            {picture ? <Image source={{ uri: picture }} accessibilityLabel={`A picture of ${home.name}`} style={{ width: '100%', height: 200, borderRadius: 16 }} resizeMode="cover" /> : null}
            <XStack gap="$2" flexWrap="wrap">
              <Button size="$3" minHeight={44} disabled={adding} onPress={() => void addPicture()}>
                {adding ? <Spinner size="small" /> : home.pictureId ? 'Another picture' : 'Add a picture'}
              </Button>
              {home.pictureId ? (
                <Button size="$3" minHeight={44} chromeless color="$muted" onPress={() => void change({ pictureId: null })}>
                  Take it away
                </Button>
              ) : null}
            </XStack>
          </YStack>

          <YStack gap="$2">
            <SectionLabel>What it is</SectionLabel>
            <Card gap="$3">
              <XStack gap="$2" alignItems="center">
                <Input flex={1} aria-label="Its name" size="$4" maxLength={60} value={name} onChangeText={setName} />
                {name.trim() && name.trim() !== home.name ? (
                  <Button size="$4" backgroundColor="$accent" color="$background" onPress={() => void change({ name: name.trim() })}>
                    Save
                  </Button>
                ) : null}
              </XStack>
              <Chips label="What it is" options={HOME_TYPES} value={home.type} onChange={(type) => void change({ type })} />
            </Card>
          </YStack>

          <YStack gap="$2">
            <SectionLabel>Its clock</SectionLabel>
            <Card gap="$3">
              <XStack gap="$2" alignItems="center">
                <Input flex={1} aria-label="Its time zone" size="$4" autoCapitalize="none" autoCorrect={false} placeholder="Europe/Stockholm" value={zone} onChangeText={setZone} />
                {zone.trim() !== home.timeZone ? (
                  <Button size="$4" backgroundColor="$accent" color="$background" disabled={!zoneValid} opacity={zoneValid ? 1 : 0.5} onPress={() => void change({ timeZone: zone.trim() })}>
                    Save
                  </Button>
                ) : null}
              </XStack>
              <Text fontSize={12} color="$muted" lineHeight={17}>
                What its automations keep time in, unless one keeps its own: a time zone, as "Europe/Stockholm".
              </Text>
            </Card>
          </YStack>

          <HomeLocation home={home} onChanged={setHome} />

          {count > 1 ? (
            <YStack gap="$2">
              <SectionLabel>Leaving it</SectionLabel>
              <Card inset>
                <Row
                  title={`Leave ${home.name}`}
                  subtitle="Moved, or sold: it goes from your homes, and what was recorded there is kept"
                  accessory={
                    <Button size="$3" minHeight={44} chromeless color="$danger" onPress={() => void leave()}>
                      Leave
                    </Button>
                  }
                />
              </Card>
            </YStack>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
