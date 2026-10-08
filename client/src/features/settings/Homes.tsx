import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Spinner, useTheme, XStack, YStack } from 'tamagui';

import { describeError, PATHS, type HomeType, type HomeView } from '@kraftverk/api-client';
import { Card, Chips, haptic, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { Screen } from '../../components/Screen';
import { useFamily } from '../../state/FamilyProvider';

/**
 * The family's homes (docs/PLAN-WORLD-MODEL.md §8.4): a house, a cabin —
 * each a place with its own clock. A family always has one; another is
 * added here, and each is its own page.
 */

/** What each kind of home is called, as the app says it. */
export const HOME_TYPES: readonly { value: HomeType; label: string }[] = [
  { value: 'house', label: 'House' },
  { value: 'apartment', label: 'Apartment' },
  { value: 'cabin', label: 'Cabin' },
  { value: 'boat', label: 'Boat' },
  { value: 'caravan', label: 'Caravan' },
  { value: 'office', label: 'Office' },
  { value: 'other', label: 'Other' },
];

/** A home in a line: what it is, whether it has said where it is, its clock. */
export const homeLine = (home: HomeView): string =>
  [HOME_TYPES.find((type) => type.value === home.type)?.label ?? home.type, home.location ? 'where it is said' : 'where it is not said yet', home.timeZone].join(' · ');

export function Homes() {
  const { api } = useFamily();
  const theme = useTheme();
  const [homes, setHomes] = useState<HomeView[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<HomeType>('house');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setHomes(await api.homes.list());
      setProblem(null);
    } catch (err) {
      setProblem(describeError(err) || 'The homes could not be read');
    }
  }, [api]);
  useEffect(() => void load(), [load]);

  const add = async () => {
    haptic();
    setAdding(true);
    setProblem(null);
    try {
      // On this app's clock, until its own is said on its page.
      const made = await api.homes.add({ name: name.trim(), type, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
      setName('');
      router.push(PATHS.settings.home(made.id));
    } catch (err) {
      setProblem(describeError(err) || 'It could not be added');
    } finally {
      setAdding(false);
      void load();
    }
  };

  const chevron = <Icon name="chevron-right" size={16} color={theme.muted?.val} />;
  return (
    <Screen back="App settings" backTo={PATHS.settings.index} title="Homes" subtitle="Where your family lives, or spends time: each with its own place and clock">
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
      {!homes && !problem ? <Spinner color="$accent" /> : null}
      {homes ? (
        <YStack gap="$2">
          <SectionLabel>Your homes</SectionLabel>
          <Card inset>
            {homes.map((home, index) => (
              <YStack key={home.id}>
                {index > 0 ? <RowSeparator /> : null}
                <Pressable onPress={() => router.push(PATHS.settings.home(home.id))}>
                  <Row title={home.name} subtitle={homeLine(home)} accessory={chevron} />
                </Pressable>
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>Add a home</SectionLabel>
        <Card gap="$3">
          <Input aria-label="Its name" placeholder="Its name: Lake cabin" size="$4" maxLength={60} value={name} onChangeText={setName} />
          <Chips label="What it is" options={HOME_TYPES} value={type} onChange={setType} />
          <XStack>
            <Button size="$3" minHeight={44} backgroundColor="$accent" color="$background" disabled={!name.trim() || adding} opacity={!name.trim() || adding ? 0.5 : 1} onPress={() => void add()}>
              {adding ? <Spinner size="small" /> : 'Add it'}
            </Button>
          </XStack>
        </Card>
      </YStack>
    </Screen>
  );
}
