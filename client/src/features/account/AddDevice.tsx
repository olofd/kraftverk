import { useState } from 'react';
import { Share } from 'react-native';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError } from '@kraftverk/api-client';
import { Card, haptic, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useAccount } from '../../state/AccountProvider';
import { useFamily } from '../../state/FamilyProvider';

/**
 * Another device of yours signed in from this one (docs/PLAN-WORLD-MODEL.md
 * §10.2): it shows a code — its own new key — which this device signs into
 * your account; the family is shown who you are now, and the code this shows
 * back makes the other device yours too.
 */
export function AddDevice() {
  const { account, personal, reload } = useAccount();
  const { api, role } = useFamily();
  const [code, setCode] = useState('');
  const [welcome, setWelcome] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const add = async () => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      const added = await personal.addDevice(account.personId, code.trim());
      // A family on a server takes the new key now, so the other device signs in there at once.
      if (role === 'follower') await api.people.present(added.chain).catch(() => undefined);
      setWelcome(added.welcome);
      await reload();
    } catch (err) {
      setProblem(describeError(err) || 'That device could not be added');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Add another device</SectionLabel>
      <Card gap="$3">
        {welcome ? (
          <>
            <Text fontSize={13} color="$muted" lineHeight={19}>
              Signed in. Paste this code on the other device — send it to yourself — and it is yours too.
            </Text>
            <Text fontSize={11} color="$color" userSelect="text">
              {welcome}
            </Text>
            <XStack gap="$2">
              <Button size="$3" minHeight={44} backgroundColor="$accent" color="$background" onPress={() => void Share.share({ message: welcome }).catch(() => undefined)}>
                Share the code
              </Button>
              <Button size="$3" minHeight={44} chromeless onPress={() => (setWelcome(null), setCode(''))}>
                Done
              </Button>
            </XStack>
          </>
        ) : (
          <>
            <Text fontSize={13} color="$muted" lineHeight={19}>
              On the other device, choose “I have an account”, then “From my other device”: it shows a code. Paste it here.
            </Text>
            <Input size="$4" aria-label="The other device’s code" autoCapitalize="none" autoCorrect={false} value={code} onChangeText={setCode} />
            <XStack>
              <Button size="$3" minHeight={44} backgroundColor="$accent" color="$background" disabled={!code.trim() || busy} opacity={code.trim() && !busy ? 1 : 0.5} onPress={() => void add()}>
                {busy ? <Spinner size="small" /> : 'Sign it in'}
              </Button>
            </XStack>
          </>
        )}
        {problem ? <ErrorText>{problem}</ErrorText> : null}
      </Card>
    </YStack>
  );
}
