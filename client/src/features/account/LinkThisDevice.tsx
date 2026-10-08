import { useEffect, useState } from 'react';
import { Share } from 'react-native';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, type PersonalApi } from '@kraftverk/api-client';
import { Card, haptic } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { QrCode } from '../../components/QrCode';
import { thisNode } from '../../platform/node';

/**
 * This device, as another device of an account you have (docs/PLAN-WORLD-MODEL.md
 * §10.2): it makes its own key and shows a code; your other device, where the
 * account is, signs it in (App settings › You › Add another device) and shows
 * a code back; pasted here, this device is that account too. Private keys
 * never move between devices: only these codes do.
 */
export function LinkThisDevice({ personal, onDone, onBack }: { personal: PersonalApi; onDone: () => Promise<void>; onBack: () => void }) {
  const [deviceName, setDeviceName] = useState(thisNode().name);
  const [link, setLink] = useState<{ keyId: string; code: string } | null>(null);
  const [welcome, setWelcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A key made and never used goes when this is left.
  useEffect(() => () => void (link && personal.forgetKey(link.keyId)), [link, personal]);

  const doing = async (work: () => Promise<void>, failed: string) => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem(describeError(err) || failed);
    } finally {
      setBusy(false);
    }
  };

  if (!link)
    return (
      <>
        <YStack gap="$2">
          <Text role="heading" fontSize={26} fontWeight="800" color="$color">
            From your other device
          </Text>
          <Text fontSize={14} color="$muted" lineHeight={20}>
            This device makes a key of its own and shows a code. Your other device signs it in, and shows a code back.
          </Text>
        </YStack>
        <Card gap="$1.5">
          <Text fontSize={13} fontWeight="600" color="$color">
            This device
          </Text>
          <Input size="$4" aria-label="What this device is called" maxLength={60} value={deviceName} onChangeText={setDeviceName} />
        </Card>
        <XStack gap="$2" justifyContent="space-between">
          <Button size="$4" minHeight={44} chromeless onPress={onBack}>
            Back
          </Button>
          <Button size="$4" minHeight={44} backgroundColor="$accent" color="$background" disabled={!deviceName.trim() || busy} onPress={() => void doing(async () => setLink(await personal.linkCode(deviceName.trim())), 'This device’s code could not be made')}>
            {busy ? <Spinner size="small" /> : 'Show my code'}
          </Button>
        </XStack>
        {problem ? <ErrorText>{problem}</ErrorText> : null}
      </>
    );

  return (
    <>
      <YStack gap="$2">
        <Text role="heading" fontSize={26} fontWeight="800" color="$color">
          On your other device
        </Text>
        <Text fontSize={14} color="$muted" lineHeight={20}>
          Open kraftverk there, and go to App settings › You › Add another device. Give it this code — scan it, or send it to yourself.
        </Text>
      </YStack>
      <Card gap="$3" alignItems="center">
        <QrCode value={link.code} label="This device’s code, as a QR code" size={200} />
        <Text fontSize={11} color="$muted" userSelect="text" width="100%">
          {link.code}
        </Text>
        <Button size="$3" minHeight={44} onPress={() => void Share.share({ message: link.code }).catch(() => undefined)}>
          Share the code
        </Button>
      </Card>
      <Card gap="$3">
        <Text fontSize={13} fontWeight="600" color="$color">
          Then paste the code it shows back
        </Text>
        <Input size="$4" aria-label="The code your other device shows" autoCapitalize="none" autoCorrect={false} value={welcome} onChangeText={setWelcome} />
        <XStack justifyContent="flex-end">
          <Button
            size="$4"
            minHeight={44}
            backgroundColor="$accent"
            color="$background"
            disabled={!welcome.trim() || busy}
            onPress={() =>
              void doing(async () => {
                const account = await personal.adopt(link.keyId, welcome.trim());
                await personal.activate(account.personId);
                setLink(null);
                await onDone();
              }, 'That code did not work')
            }
          >
            {busy ? <Spinner size="small" /> : 'Done'}
          </Button>
        </XStack>
      </Card>
      {problem ? <ErrorText>{problem}</ErrorText> : null}
    </>
  );
}
