import { useEffect, useState } from 'react';
import { Image } from 'react-native';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError } from '@kraftverk/api-client';
import { checkChain, type Profile } from '@kraftverk/identity';
import { Card, haptic, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { confirmAction } from '../../platform/confirm';
import { pickPicture, usePicture } from '../../platform/picture';
import { useAccount } from '../../state/AccountProvider';
import { useFamily } from '../../state/FamilyProvider';

/**
 * Who uses this app, in App settings (docs/PLAN-WORLD-MODEL.md §10.6): the
 * account it opens as, and what it links; your own name and picture, said
 * by you and shown to your family; signing out — back to the
 * accounts this device keeps, its key kept — and removing it from this
 * device, its key gone with it.
 */
export function YourAccount() {
  const { account, accounts, personal, signOut, reload } = useAccount();
  const [problem, setProblem] = useState<string | null>(null);
  const others = accounts.length - 1;

  const remove = async () => {
    const ways = account.linked.length ? 'your recovery words, or by signing in with what you linked where your family takes it' : 'your recovery words';
    if (!(await confirmAction(`Remove ${account.name} from this device?`, `Its key goes, and this device can no longer open it. Its families stay where they are kept. Coming back to it on this device takes ${ways}.`, 'Remove', 'dangerous'))) return;
    haptic();
    try {
      await personal.remove(account.personId);
      await reload();
    } catch (err) {
      setProblem(describeError(err) || 'It could not be removed');
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>You</SectionLabel>
      <YourProfile />
      <Card inset>
        <Row
          title={account.name}
          subtitle={[`On ${account.deviceName}`, account.linked.length ? `linked: ${account.linked.map((each) => each.email ?? each.provider).join(', ')}` : 'a local account', account.recoveryConfirmed ? null : 'recovery words never checked'].filter(Boolean).join(' · ')}
        />
        <RowSeparator />
        <Row
          title={others ? 'Switch account' : 'Sign out'}
          subtitle={others ? `${others} other account${others === 1 ? '' : 's'} on this device; or add one` : 'Back to the start: this device keeps your account, to open again with a tap'}
          accessory={
            <Button size="$3" minHeight={44} onPress={() => (haptic(), void signOut())}>
              {others ? 'Switch' : 'Sign out'}
            </Button>
          }
        />
        <RowSeparator />
        <Row
          title="Remove from this device"
          subtitle="Its key goes with it: coming back takes your recovery words"
          accessory={
            <Button size="$3" minHeight={44} chromeless color="$danger" onPress={() => void remove()}>
              Remove
            </Button>
          }
        />
      </Card>
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
    </YStack>
  );
}

/**
 * Your own name and picture (docs/PLAN-WORLD-MODEL.md §8.3): yours to say,
 * signed by this device into who you are, and shown to the family open now
 * — every other family of yours hears it when it is next opened. What a
 * family calls you, and your colour there, stay the family's.
 */
function YourProfile() {
  const { account, personal, reload } = useAccount();
  const { api } = useFamily();
  const [name, setName] = useState(account.name);
  const [shortName, setShortName] = useState(account.shortName ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => (setName(account.name), setShortName(account.shortName ?? '')), [account.name, account.shortName]);
  const picture = usePicture(api, account.pictureId);

  const say = async (changes: Partial<Profile>) => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      const checked = checkChain(await personal.chain(account.personId));
      if (!checked.ok) throw new Error(checked.problem);
      await personal.say(account.personId, { kind: 'profile', profile: { ...checked.person.profile, ...changes } });
      await api.people.present(await personal.chain(account.personId));
      await reload();
    } catch (err) {
      setProblem(describeError(err) || 'That could not be changed');
    } finally {
      setBusy(false);
    }
  };
  const addPicture = async () => {
    try {
      const picked = await pickPicture();
      if (picked) await say({ pictureId: (await api.media.add(picked)).id });
    } catch (err) {
      setProblem(describeError(err) || 'The picture could not be added');
    }
  };

  const named = name.trim();
  const short = shortName.trim();
  const changed = (named && named !== account.name) || short !== (account.shortName ?? '');
  return (
    <Card gap="$3">
      <XStack gap="$3" alignItems="center">
        {picture ? (
          <Image source={{ uri: picture }} accessibilityLabel={`A picture of ${account.name}`} style={{ width: 64, height: 64, borderRadius: 32 }} resizeMode="cover" />
        ) : (
          <YStack width={64} height={64} borderRadius={32} backgroundColor="$borderColor" alignItems="center" justifyContent="center">
            <Text fontSize={24} fontWeight="700" color="$muted">
              {account.name.charAt(0).toUpperCase()}
            </Text>
          </YStack>
        )}
        <XStack gap="$2" flexWrap="wrap" flex={1}>
          <Button size="$3" minHeight={44} disabled={busy} onPress={() => void addPicture()}>
            {account.pictureId ? 'Another picture' : 'Add a picture'}
          </Button>
          {account.pictureId ? (
            <Button size="$3" minHeight={44} chromeless color="$muted" disabled={busy} onPress={() => void say({ pictureId: null })}>
              Take it away
            </Button>
          ) : null}
        </XStack>
      </XStack>
      <YStack gap="$1.5">
        <Text fontSize={13} fontWeight="600" color="$color">
          Your name
        </Text>
        <Input size="$4" aria-label="Your name" maxLength={100} value={name} onChangeText={setName} />
      </YStack>
      <YStack gap="$1.5">
        <Text fontSize={13} fontWeight="600" color="$color">
          What you go by
        </Text>
        <Input size="$4" aria-label="What you go by" maxLength={30} placeholder={named.split(' ')[0]} value={shortName} onChangeText={setShortName} />
        <Text fontSize={12} color="$muted" lineHeight={17}>
          Yours, everywhere you are. A family may still call you something of its own.
        </Text>
      </YStack>
      {changed ? (
        <XStack>
          <Button size="$3" minHeight={44} backgroundColor="$accent" color="$background" disabled={busy || !named} opacity={busy || !named ? 0.5 : 1} onPress={() => void say({ name: named, shortName: short || null })}>
            {busy ? <Spinner size="small" /> : 'Save'}
          </Button>
        </XStack>
      ) : null}
      {problem ? <ErrorText>{problem}</ErrorText> : null}
    </Card>
  );
}
