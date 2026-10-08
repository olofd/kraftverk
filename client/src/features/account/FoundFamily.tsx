import { useState } from 'react';
import { Button, Input, ScrollView, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, type HomeType, type HomeView, type KraftverkApi } from '@kraftverk/api-client';
import { isTimeZone } from '@kraftverk/device-sdk';
import { Card, Chips, haptic } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useAccount } from '../../state/AccountProvider';
import { HomeLocation } from '../settings/HomeLocation';
import { HOME_TYPES } from '../settings/Homes';

/*
  An account's own family, founded (docs/PLAN-WORLD-MODEL.md §10.6): its
  name and what it is, then its first home — what it is called, what it
  is, its clock — and where it is. This device is its master: a family of
  one, with no server, until others are invited.
*/

type Kind = 'family' | 'household' | 'friends' | 'other';

const KINDS: readonly { value: Kind; label: string }[] = [
  { value: 'family', label: 'A family' },
  { value: 'household', label: 'A household' },
  { value: 'friends', label: 'Friends' },
  { value: 'other', label: 'Something else' },
];

/** What the family is called on screen, by what it is: "your family", "your household". */
const ITS: Record<Kind, string> = { family: 'family', household: 'household', friends: 'group of friends', other: 'group' };

/** This device's clock: what a first home keeps until its people say otherwise. */
const deviceZone = (): string => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isTimeZone(zone) ? zone : 'UTC';
};

export function FoundFamily({ api, onFounded }: { api: KraftverkApi; onFounded: () => void }) {
  const { personal, account, reload } = useAccount();
  const [kind, setKind] = useState<Kind>('family');
  const [name, setName] = useState('');
  const [homeName, setHomeName] = useState('Home');
  const [homeType, setHomeType] = useState<HomeType>('house');
  const [zone, setZone] = useState(deviceZone);
  const [home, setHome] = useState<HomeView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zoneValid = isTimeZone(zone.trim());
  const ready = name.trim().length > 0 && homeName.trim().length > 0 && zoneValid;

  const found = async () => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      await api.people.found({ chain: await personal.chain(account.personId), name: name.trim(), kind, home: { name: homeName.trim(), type: homeType, timeZone: zone.trim() } });
      const family = await api.family();
      await personal.keepFamily(account.personId, { familyId: family.id, name: family.name, master: 'here', serverUrl: null, joinedAt: new Date().toISOString() });
      setHome((await api.homes.list())[0] ?? null);
    } catch (err) {
      setProblem(describeError(err) || 'Your family could not be made');
    } finally {
      setBusy(false);
    }
  };
  const done = async () => {
    haptic();
    await reload();
    onFounded();
  };

  return (
    <ScrollView flex={1} backgroundColor="$background" contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 16 }}>
      <YStack width="100%" maxWidth={440} alignSelf="center" gap="$4" paddingVertical="$6">
        {!home ? (
          <>
            <YStack gap="$2">
              <Text role="heading" fontSize={26} fontWeight="800" color="$color">
                Your {ITS[kind]}
              </Text>
              <Text fontSize={14} color="$muted" lineHeight={20}>
                The people you share your devices and homes with. It starts with you, on this device; you can invite the others later.
              </Text>
            </YStack>
            <Card gap="$3">
              <Chips label="What it is" options={KINDS} value={kind} onChange={setKind} />
              <YStack gap="$1.5">
                <Text fontSize={13} fontWeight="600" color="$color">
                  What you call it
                </Text>
                <Input size="$4" aria-label="What you call it" autoFocus maxLength={60} value={name} onChangeText={setName} placeholder={kind === 'family' ? 'The Examples' : kind === 'friends' ? 'The cabin crew' : 'Our home'} />
              </YStack>
            </Card>
            <YStack gap="$2">
              <Text fontSize={15} fontWeight="700" color="$color">
                Your first home
              </Text>
              <Card gap="$3">
                <Input size="$4" aria-label="Your first home’s name" maxLength={60} value={homeName} onChangeText={setHomeName} />
                <Chips label="What it is" options={HOME_TYPES} value={homeType} onChange={setHomeType} />
                <YStack gap="$1.5">
                  <Text fontSize={13} fontWeight="600" color="$color">
                    Its clock
                  </Text>
                  <Input size="$4" aria-label="Its time zone" autoCapitalize="none" autoCorrect={false} value={zone} onChangeText={setZone} />
                  <Text fontSize={12} color={zoneValid ? '$muted' : '$danger'} lineHeight={17}>
                    {zoneValid ? 'What its automations keep time in: this device’s, unless you say another, as "Europe/Stockholm".' : `"${zone.trim()}" is not a time zone: as "Europe/Stockholm".`}
                  </Text>
                </YStack>
              </Card>
            </YStack>
            <Button size="$5" minHeight={52} backgroundColor="$accent" color="$background" fontWeight="700" disabled={!ready || busy} opacity={ready && !busy ? 1 : 0.5} onPress={() => void found()}>
              {busy ? <Spinner size="small" /> : 'Continue'}
            </Button>
          </>
        ) : (
          <>
            <YStack gap="$2">
              <Text role="heading" fontSize={26} fontWeight="800" color="$color">
                Where is {home.name}?
              </Text>
              <Text fontSize={14} color="$muted" lineHeight={20}>
                So automations know when the sun rises and sets there, and the weather is for the right place. It stays in your family’s own database.
              </Text>
            </YStack>
            <HomeLocation home={home} onChanged={setHome} api={api} />
            <XStack justifyContent="flex-end" gap="$2">
              <Button size="$5" minHeight={52} backgroundColor="$accent" color="$background" fontWeight="700" onPress={() => void done()}>
                {home.location ? 'Done' : 'Skip for now'}
              </Button>
            </XStack>
          </>
        )}
        {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
      </YStack>
    </ScrollView>
  );
}
