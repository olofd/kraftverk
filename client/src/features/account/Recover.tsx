import { useState } from 'react';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, type PersonalApi } from '@kraftverk/api-client';
import { httpApi, serverApi } from '@kraftverk/api-client/http';
import { areRecoveryWords, keyId, recoveryKey } from '@kraftverk/identity';
import { Card, haptic } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { thisNode } from '../../platform/node';
import { useServers } from '../../state/ServersProvider';

/**
 * Back with the twelve recovery words, every device lost
 * (docs/PLAN-WORLD-MODEL.md §10.2): the server your family is kept on knows
 * who you are — your chain — and the words make the key that proves it is
 * you. This device makes its own key, the words sign it in, and you are
 * yourself again, there and everywhere you show it. The words never leave
 * this device.
 */
export function Recover({ personal, onDone, onBack }: { personal: PersonalApi; onDone: () => Promise<void>; onBack: () => void }) {
  const servers = useServers();
  const [words, setWords] = useState('');
  const [address, setAddress] = useState(servers.active?.url.replace(/\/api$/, '') ?? '');
  const [deviceName, setDeviceName] = useState(thisNode().name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const list = words.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const wordsOk = list.length === 12 && areRecoveryWords(list);

  const recover = async () => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      const baseUrl = `${address.trim().replace(/\/+$/, '').replace(/\/api$/, '')}/api`;
      const server = serverApi({ baseUrl });
      // Whose the words are, at that server: its family knows the key they make.
      const person = await server.auth.holder(keyId(recoveryKey(list).publicJwk));
      if (!person) throw new Error('No one in the family there has these words: check them, and the address');
      await server.auth.signInWithKey(await personal.recoveryAnswer(list, await server.auth.challenge(), person));
      const family = httpApi({ baseUrl });
      const [chain, kept] = await Promise.all([family.people.myChain(), family.family()]);
      const { account, chain: renewed } = await personal.recover({
        words: list,
        chain,
        deviceName: deviceName.trim(),
        families: [{ familyId: kept.id, name: kept.name, master: 'server', serverUrl: baseUrl, joinedAt: new Date().toISOString() }],
      });
      // The family takes this device's key, signed in by the words: it signs in by it from now.
      await family.people.present(renewed);
      const saved = servers.all.find((each) => each.url === baseUrl) ?? (await servers.add({ url: baseUrl, name: kept.name }));
      await personal.activate(account.personId);
      servers.use(saved.id);
      await onDone();
    } catch (err) {
      setProblem(describeError(err) || 'Your account could not be brought back');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <YStack gap="$2">
        <Text role="heading" fontSize={26} fontWeight="800" color="$color">
          With your recovery words
        </Text>
        <Text fontSize={14} color="$muted" lineHeight={20}>
          Your family’s server keeps who you are; your twelve words prove it is you. They never leave this device.
        </Text>
      </YStack>
      <Card gap="$3">
        <YStack gap="$1.5">
          <Text fontSize={13} fontWeight="600" color="$color">
            Your twelve words, in order
          </Text>
          <Input size="$4" aria-label="Your twelve recovery words" multiline numberOfLines={3} autoCapitalize="none" autoCorrect={false} autoComplete="off" spellCheck={false} value={words} onChangeText={setWords} />
          {list.length === 12 && !wordsOk ? <ErrorText>One of them is not right: check each one against your paper.</ErrorText> : null}
        </YStack>
        <YStack gap="$1.5">
          <Text fontSize={13} fontWeight="600" color="$color">
            Your family’s server
          </Text>
          <Input size="$4" aria-label="Your family’s server" autoCapitalize="none" autoCorrect={false} placeholder="https://home.example.net" value={address} onChangeText={setAddress} />
        </YStack>
        <YStack gap="$1.5">
          <Text fontSize={13} fontWeight="600" color="$color">
            This device
          </Text>
          <Input size="$4" aria-label="What this device is called" maxLength={60} value={deviceName} onChangeText={setDeviceName} />
        </YStack>
      </Card>
      <XStack gap="$2" justifyContent="space-between">
        <Button size="$4" minHeight={44} chromeless onPress={onBack} disabled={busy}>
          Back
        </Button>
        <Button size="$4" minHeight={44} backgroundColor="$accent" color="$background" disabled={!wordsOk || !address.trim() || !deviceName.trim() || busy} opacity={wordsOk && address.trim() && !busy ? 1 : 0.5} onPress={() => void recover()}>
          {busy ? <Spinner size="small" /> : 'Bring my account back'}
        </Button>
      </XStack>
      {problem ? <ErrorText>{problem}</ErrorText> : null}
    </>
  );
}
