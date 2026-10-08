import { useCallback, useEffect, useState } from 'react';
import { Share } from 'react-native';
import { Button, Input, Spinner, Text, XStack, YStack } from 'tamagui';

import { describeError, invitationLink, PATHS, type InvitationView, type MemberRole, type PersonView } from '@kraftverk/api-client';
import { Card, Chips, haptic, Row, RowSeparator, SectionLabel, ToggleRow } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { QrCode } from '../../components/QrCode';
import { Screen } from '../../components/Screen';
import { useAccount } from '../../state/AccountProvider';
import { useFamily } from '../../state/FamilyProvider';
import { useServers } from '../../state/ServersProvider';

/*
  The family's people (docs/PLAN-WORLD-MODEL.md §8.2, §8.3): who is in it,
  as each one's own account says, their role and colour — and, for an
  admin, inviting someone: a link and a QR code, taken once, by someone
  with their own account, who is in from then or waits to be let in.
  Inviting needs a server they can reach: a family kept on one phone has
  no door anyone else can knock on.
*/

const ROLES: readonly { value: MemberRole; label: string }[] = [
  { value: 'member', label: 'A member' },
  { value: 'admin', label: 'An admin' },
  { value: 'child', label: 'A child' },
];
const ROLE_WORDS: Record<MemberRole, string> = { admin: 'Admin', member: 'Member', child: 'Child' };
const STATUS_WORDS: Record<InvitationView['status'], string> = { open: 'Not taken yet', used: 'Taken', waiting: 'Taken: waiting for you to let them in', expired: 'Expired', revoked: 'Taken back' };

export function People() {
  const { api, role } = useFamily();
  const { account } = useAccount();
  const { active } = useServers();
  const [people, setPeople] = useState<PersonView[] | null>(null);
  const [invitations, setInvitations] = useState<InvitationView[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const me = people?.find((person) => person.id === account.personId) ?? null;
  const admin = me?.member?.role === 'admin';

  const load = useCallback(async () => {
    try {
      const members = await api.people.list();
      setPeople(members);
      if (members.find((person) => person.id === account.personId)?.member?.role === 'admin') setInvitations(await api.people.invitations());
    } catch (err) {
      setProblem(describeError(err) || 'The family’s people could not be read');
    }
  }, [account.personId, api]);
  useEffect(() => void load(), [load]);

  const doing = async (work: () => Promise<unknown>, failed: string) => {
    haptic();
    setProblem(null);
    try {
      await work();
      await load();
    } catch (err) {
      setProblem(describeError(err) || failed);
    }
  };

  const waiting = invitations.filter((each) => each.status === 'waiting');
  return (
    <Screen back="App settings" backTo={PATHS.settings.index} title="People" subtitle="Who your family is, and inviting someone">
      {!people ? <Spinner color="$accent" /> : null}
      {people ? (
        <YStack gap="$2">
          <SectionLabel>In your family</SectionLabel>
          <Card inset>
            {people.map((person, index) => (
              <YStack key={person.id}>
                {index ? <RowSeparator /> : null}
                <Row
                  leading={<YStack width={14} height={14} borderRadius={7} backgroundColor={(person.member?.color ?? '$borderColor') as never} />}
                  title={`${person.shownAs}${person.id === account.personId ? ' (you)' : ''}`}
                  subtitle={[person.member ? ROLE_WORDS[person.member.role] : null, person.shownAs !== person.name ? person.name : null, person.keys.length ? null : 'No device of their own yet'].filter(Boolean).join(' · ')}
                />
                {admin && person.member && person.id !== account.personId ? (
                  <XStack paddingHorizontal="$4" paddingBottom="$3">
                    <Chips label={`${person.shownAs}'s role`} options={ROLES} value={person.member.role} onChange={(next) => void doing(() => api.people.update(person.id, { role: next }), 'Their role could not be changed')} />
                  </XStack>
                ) : null}
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}

      {admin && waiting.length ? (
        <YStack gap="$2">
          <SectionLabel>Waiting to be let in</SectionLabel>
          <Card inset>
            {waiting.map((invitation, index) => (
              <YStack key={invitation.id}>
                {index ? <RowSeparator /> : null}
                <Row
                  title={invitation.forName ?? 'Someone you invited'}
                  subtitle={`As ${ROLE_WORDS[invitation.role].toLowerCase()} · took it ${invitation.usedAt?.slice(0, 10)}`}
                  accessory={
                    <XStack gap="$2">
                      <Button size="$3" minHeight={44} chromeless color="$danger" onPress={() => void doing(() => api.people.revokeInvitation(invitation.id), 'It could not be taken back')}>
                        Refuse
                      </Button>
                      <Button size="$3" minHeight={44} backgroundColor="$accent" color="$background" onPress={() => void doing(() => api.people.approve(invitation.id), 'They could not be let in')}>
                        Let in
                      </Button>
                    </XStack>
                  }
                />
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}

      {admin ? role === 'master' || !active ? <NeedsServer /> : <Invite serverUrl={active.url} onMade={load} /> : null}

      {admin && invitations.filter((each) => each.status !== 'waiting').length ? (
        <YStack gap="$2">
          <SectionLabel>Invitations</SectionLabel>
          <Card inset>
            {invitations
              .filter((each) => each.status !== 'waiting')
              .slice(0, 10)
              .map((invitation, index) => (
                <YStack key={invitation.id}>
                  {index ? <RowSeparator /> : null}
                  <Row
                    title={invitation.forName ?? 'Anyone with the link'}
                    subtitle={`${STATUS_WORDS[invitation.status]} · ${ROLE_WORDS[invitation.role].toLowerCase()} · until ${invitation.expiresAt.slice(0, 10)}`}
                    accessory={
                      invitation.status === 'open' ? (
                        <Button size="$3" minHeight={44} chromeless color="$danger" onPress={() => void doing(() => api.people.revokeInvitation(invitation.id), 'It could not be taken back')}>
                          Take back
                        </Button>
                      ) : undefined
                    }
                  />
                </YStack>
              ))}
          </Card>
        </YStack>
      ) : null}
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
    </Screen>
  );
}

/** Why there is no inviting yet: the family is kept on this device, which no one else can reach. */
function NeedsServer() {
  return (
    <YStack gap="$2">
      <SectionLabel>Inviting someone</SectionLabel>
      <Card gap="$2">
        <Text fontSize={15} fontWeight="600" color="$color">
          Your family is kept on this device
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          Someone joining needs a place they can reach, and a phone or a browser is not one. Add a kraftverk server under App settings and keep your family there: then you can invite anyone.
        </Text>
      </Card>
    </YStack>
  );
}

/** An invitation made: who it is for, as what, and whether they wait to be let in — then its link and QR code, this once. */
function Invite({ serverUrl, onMade }: { serverUrl: string; onMade: () => Promise<void> }) {
  const { api } = useFamily();
  const [forName, setForName] = useState('');
  const [role, setRole] = useState<MemberRole>('member');
  const [needsApproval, setNeedsApproval] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const make = async () => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      const made = await api.people.invite({ role, forName: forName.trim() || null, needsApproval });
      setLink(invitationLink(serverUrl, made.invitation.id, made.secret));
      await onMade();
    } catch (err) {
      setProblem(describeError(err) || 'The invitation could not be made');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Invite someone</SectionLabel>
      <Card gap="$3">
        {link ? (
          <>
            <Text fontSize={13} color="$muted" lineHeight={19}>
              Give them this link, or let them scan it. They open it in kraftverk with an account of their own. It works once, for a week — it is shown only now.
            </Text>
            <YStack alignSelf="center">
              <QrCode value={link} label="The invitation, as a QR code" />
            </YStack>
            <Text fontSize={12} color="$color" userSelect="text" lineHeight={17}>
              {link}
            </Text>
            <XStack gap="$2" flexWrap="wrap">
              <Button size="$3" minHeight={44} backgroundColor="$accent" color="$background" onPress={() => void Share.share({ message: `Join our family on kraftverk: ${link}` }).catch(() => undefined)}>
                Share the link
              </Button>
              <Button size="$3" minHeight={44} chromeless onPress={() => (setLink(null), setForName(''))}>
                Invite someone else
              </Button>
            </XStack>
          </>
        ) : (
          <>
            <Input size="$4" aria-label="Who it is for" placeholder="Who it is for: Grandma (optional)" maxLength={60} value={forName} onChangeText={setForName} />
            <Chips label="As" options={ROLES} value={role} onChange={setRole} />
            <ToggleRow title="Let them in yourself" subtitle="They wait until an admin says yes, after taking it" checked={needsApproval} onCheckedChange={setNeedsApproval} />
            <XStack>
              <Button size="$4" minHeight={44} backgroundColor="$accent" color="$background" disabled={busy} onPress={() => void make()}>
                {busy ? <Spinner size="small" /> : 'Make an invitation'}
              </Button>
            </XStack>
          </>
        )}
        {problem ? <ErrorText>{problem}</ErrorText> : null}
      </Card>
    </YStack>
  );
}
