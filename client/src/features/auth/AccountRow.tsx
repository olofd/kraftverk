import { useState } from 'react';
import { Button, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, PASSWORD_MIN, type AccountDetail } from '@kraftverk/api-client';
import { haptic, Icon, Row } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { useAuth } from '../../state/AuthProvider';
import { useServer } from '../../state/ServersProvider';
import { ConfirmWithYours } from './ConfirmWithYours';
import { Field, passwordProblem, suggestPassword } from './fields';

export function AccountRow({
  account,
  isMe,
  onlyOne,
  onChanged,
}: {
  account: AccountDetail;
  isMe: boolean;
  onlyOne: boolean;
  onChanged: () => Promise<void>;
}) {
  const server = useServer();
  const theme = useTheme();
  const { logOut } = useAuth();
  const [action, setAction] = useState<'idle' | 'confirm-remove' | 'reset'>('idle');
  const [password, setPassword] = useState('');
  const [yours, setYours] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const cancel = () => {
    setAction('idle');
    setPassword('');
    setYours('');
    setProblem(null);
  };

  const seen = account.lastLoginAt ? `last login ${new Date(account.lastLoginAt).toLocaleString()}` : 'never logged in';

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      cancel();
      await onChanged();
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack>
      <Row
        title={`${account.username}${isMe ? ' (you)' : ''}`}
        subtitle={`Added ${new Date(account.createdAt).toLocaleDateString()}${account.createdBy ? ` by ${account.createdBy}` : ''} · ${seen}`}
        accessory={
          action === 'idle' ? (
            <XStack gap="$2">
              {isMe ? null : (
                <Button size="$2" onPress={() => setAction('reset')}>
                  New password
                </Button>
              )}
              {onlyOne ? null : (
                <Button
                  size="$2"
                  borderColor="$danger"
                  icon={<Icon name="trash-2" size={12} color={theme.danger?.val} />}
                  onPress={() => setAction('confirm-remove')}
                >
                  Remove
                </Button>
              )}
            </XStack>
          ) : null
        }
      />
      {action === 'confirm-remove' ? (
        <YStack paddingHorizontal="$4" paddingBottom="$3" gap="$2">
          <Text fontSize={13} color="$color" lineHeight={19}>
            Remove {account.username}? They are signed out everywhere and can no longer log in.
            {isMe ? ' That includes you, on this device.' : ''}
          </Text>
          <ConfirmWithYours value={yours} onChange={setYours} />
          <XStack gap="$2">
            <Button flex={1} size="$3" disabled={busy} onPress={cancel}>
              Cancel
            </Button>
            <Button
              flex={1}
              size="$3"
              backgroundColor="$danger"
              color="$background"
              disabled={busy || !yours}
              opacity={busy || !yours ? 0.5 : 1}
              onPress={() => {
                haptic();
                void run(async () => {
                  await server.accounts.remove(account.id, yours);
                  // Signed out by the server already; this also clears what the app held.
                  if (isMe) await logOut();
                });
              }}
            >
              Remove
            </Button>
          </XStack>
        </YStack>
      ) : null}
      {action === 'reset' ? (
        <YStack paddingHorizontal="$4" paddingBottom="$3" gap="$2">
          <Field
            label={`New password for ${account.username}`}
            kind="new-password"
            value={password}
            onChange={setPassword}
            hint={`At least ${PASSWORD_MIN} characters. They are signed out everywhere, and need this to log in again — pass it on somewhere private.`}
          />
          <ConfirmWithYours value={yours} onChange={setYours} />
          <XStack gap="$2" flexWrap="wrap">
            <Button size="$3" onPress={() => setPassword(suggestPassword())}>
              Suggest one
            </Button>
            <Button size="$3" disabled={busy} onPress={cancel}>
              Cancel
            </Button>
            <Button
              size="$3"
              backgroundColor="$accent"
              color="$background"
              disabled={busy || !yours || passwordProblem(password) !== null}
              opacity={busy || !yours || passwordProblem(password) !== null ? 0.5 : 1}
              onPress={() => {
                haptic();
                void run(() => server.accounts.setPassword(account.id, password, yours));
              }}
            >
              Set password
            </Button>
          </XStack>
        </YStack>
      ) : null}
      {problem ? (
        <ErrorText paddingHorizontal="$4" paddingBottom="$3">
          {problem}
        </ErrorText>
      ) : null}
    </YStack>
  );
}
