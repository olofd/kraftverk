import { useState } from 'react';
import { Button, Input, Spinner, Text, XStack } from 'tamagui';

import { describeError, readInvitationLink, type SharingLevel } from '@kraftverk/api-client';
import { serverApi } from '@kraftverk/api-client/http';
import { Card, haptic } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useAccount } from '../../state/AccountProvider';
import { useServers } from '../../state/ServersProvider';
import { SharingChoice } from './SharingChoice';

/**
 * Joining a family with an invitation (docs/PLAN-WORLD-MODEL.md §8.3): its
 * link, pasted — or scanned — into the app, taken with this device's
 * account. In from then, the family's server is this app's and its key
 * signs in there; or waiting for one of its admins to let you in.
 */
export function JoinFamily({ onBack }: { onBack?: () => void }) {
  const { personal, account, reload } = useAccount();
  const servers = useServers();
  const [text, setText] = useState('');
  // What they share of where they are, chosen as they join: which place, offered first.
  const [sharing, setSharing] = useState<SharingLevel>('places');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<{ name: string; serverId: string } | null>(null);
  const link = readInvitationLink(text);

  const join = async () => {
    if (!link) return;
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      const joined = await serverApi({ baseUrl: link.serverUrl }).join({ invitation: link.invitation, secret: link.secret, chain: await personal.chain(account.personId), sharing });
      const server = servers.all.find((each) => each.url === link.serverUrl) ?? (await servers.add({ url: link.serverUrl, name: joined.family.name }));
      await personal.keepFamily(account.personId, { familyId: joined.family.id, name: joined.family.name, master: 'server', serverUrl: link.serverUrl, joinedAt: new Date().toISOString() });
      await reload();
      if (joined.status === 'waiting') setWaiting({ name: joined.family.name, serverId: server.id });
      // In: the family's server is this app's now, and this account's key signs in there.
      else servers.use(server.id);
    } catch (err) {
      setProblem(describeError(err) || 'The invitation could not be taken');
    } finally {
      setBusy(false);
    }
  };

  if (waiting)
    return (
      <Card gap="$3">
        <Text fontSize={15} fontWeight="700" color="$color">
          Asked to join {waiting.name}
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          One of its admins lets you in. Once they have, open it here: this device signs you in with your account, nothing to type.
        </Text>
        <XStack>
          <Button size="$4" minHeight={44} backgroundColor="$accent" color="$background" onPress={() => (haptic(), servers.use(waiting.serverId))}>
            Open {waiting.name}
          </Button>
        </XStack>
      </Card>
    );

  return (
    <Card gap="$3">
      <Text fontSize={15} fontWeight="700" color="$color">
        Join with an invitation
      </Text>
      <Text fontSize={13} color="$muted" lineHeight={19}>
        Paste the link someone in the family sent you. You join as {account.name}, with this device.
      </Text>
      <Input size="$4" aria-label="The invitation link" autoCapitalize="none" autoCorrect={false} placeholder="https://…/join#i=…" value={text} onChangeText={setText} />
      {text.trim() && !link ? <ErrorText>That is not an invitation link: it has /join# in it, then the invitation.</ErrorText> : null}
      {link ? <SharingChoice label="What the family sees of where you are" value={sharing} onChange={setSharing} /> : null}
      <XStack gap="$2" justifyContent={onBack ? 'space-between' : 'flex-end'}>
        {onBack ? (
          <Button size="$4" minHeight={44} chromeless onPress={onBack} disabled={busy}>
            Back
          </Button>
        ) : null}
        <Button size="$4" minHeight={44} backgroundColor="$accent" color="$background" disabled={!link || busy} opacity={link && !busy ? 1 : 0.5} onPress={() => void join()}>
          {busy ? <Spinner size="small" /> : 'Join'}
        </Button>
      </XStack>
      {problem ? <ErrorText>{problem}</ErrorText> : null}
    </Card>
  );
}
