import { useCallback, useEffect, useState } from 'react';
import { Button, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, Row, RowSeparator, SectionLabel, haptic, Icon } from '@kraftverk/ui';
import { describeError, type AccountDetail } from '@kraftverk/api-client';

import { Screen } from '../src/components/Screen';
import { Field, passwordProblem, suggestPassword, PASSWORD_MIN } from '../src/features/auth/fields';
import { useAuth } from '../src/state/AuthProvider';
import { useServer } from '../src/state/ServersProvider';

/**
 * Who may use this server.
 *
 * Reached only signed in: the sign-in gate stands in front of the whole app,
 * so the cases below the first two are the signed-in one. Every account is an
 * administrator for now.
 */
export default function AccountsScreen() {
  const { applies, state } = useAuth();

  return (
    <Screen back="App settings" backTo="/app-settings" title="Accounts" subtitle="Who may use this server">
      {!applies ? (
        <Card>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            Accounts belong to a server. With none, this app keeps your home itself, and there is nobody to
            log in to.
          </Text>
        </Card>
      ) : !state?.user ? (
        <Card>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            This server does not have accounts. It may be older than them — update it to use sign-in.
          </Text>
        </Card>
      ) : (
        <SignedIn />
      )}
    </Screen>
  );
}

function SignedIn() {
  const server = useServer();
  const { state, logOut } = useAuth();
  const theme = useTheme();
  const [accounts, setAccounts] = useState<AccountDetail[]>([]);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAccounts(await server.accounts.list());
      setProblem(null);
    } catch (error) {
      setProblem(describeError(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!state?.user) return null;
  const me = state.user;

  return (
    <>
      <YStack gap="$2">
        <SectionLabel>You</SectionLabel>
        <Card inset>
          <Row
            title={me.username}
            subtitle="Signed in on this device"
            accessory={
              <Button
                size="$2"
                icon={<Icon name="log-out" size={12} color={theme.color?.val} />}
                onPress={() => {
                  haptic();
                  void logOut();
                }}
              >
                Sign out
              </Button>
            }
          />
        </Card>
        <ChangeOwnPassword />
      </YStack>


      <YStack gap="$2">
        <SectionLabel>Accounts</SectionLabel>
        <Card inset>
          {accounts.map((account, index) => (
            <YStack key={account.id}>
              {index > 0 ? <RowSeparator /> : null}
              <AccountRow account={account} isMe={account.id === me.id} onlyOne={accounts.length === 1} onChanged={load} />
            </YStack>
          ))}
        </Card>
        {problem ? (
          <Text fontSize={13} color="$danger" lineHeight={18} paddingHorizontal="$1" role="alert">
            {problem}
          </Text>
        ) : null}
        <AddAccount onAdded={load} />
      </YStack>
    </>
  );
}

function AccountRow({
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
        <Text fontSize={13} color="$danger" paddingHorizontal="$4" paddingBottom="$3" role="alert">
          {problem}
        </Text>
      ) : null}
    </YStack>
  );
}

function AddAccount({ onAdded }: { onAdded: () => Promise<void> }) {
  const server = useServer();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [yours, setYours] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const invalid = !username.trim() || !yours || passwordProblem(password) !== null;
  const close = () => {
    setOpen(false);
    setUsername('');
    setPassword('');
    setYours('');
    setProblem(null);
  };

  if (!open) {
    return (
      <Button
        size="$3"
        alignSelf="flex-start"
        icon={<Icon name="user-plus" size={14} color={theme.color?.val} />}
        onPress={() => {
          haptic();
          setOpen(true);
        }}
      >
        Add an account
      </Button>
    );
  }

  return (
    <Card gap="$3">
      <Text fontSize={13} color="$muted" lineHeight={19}>
        Every account is an administrator: it can use and change everything, and manage accounts.
      </Text>
      <Field label="Username" kind="username" value={username} onChange={setUsername} autoFocus />
      <Field
        label="Password"
        kind="new-password"
        value={password}
        onChange={setPassword}
        hint={`At least ${PASSWORD_MIN} characters. Pass it on somewhere private; they can change it once they are in.`}
      />
      <ConfirmWithYours value={yours} onChange={setYours} />
      {problem ? (
        <Text fontSize={13} color="$danger" lineHeight={18} role="alert">
          {problem}
        </Text>
      ) : null}
      <XStack gap="$2" flexWrap="wrap">
        <Button size="$3" onPress={() => setPassword(suggestPassword())}>
          Suggest a password
        </Button>
        <Button
          size="$3"
          disabled={busy}
          onPress={close}
        >
          Cancel
        </Button>
        <Button
          size="$3"
          backgroundColor="$accent"
          color="$background"
          disabled={busy || invalid}
          opacity={busy || invalid ? 0.5 : 1}
          onPress={async () => {
            haptic();
            setBusy(true);
            setProblem(null);
            try {
              await server.accounts.add(username.trim(), password, yours);
              close();
              await onAdded();
            } catch (error) {
              setProblem(describeError(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          Add account
        </Button>
      </XStack>
    </Card>
  );
}

/**
 * Your own password, asked for again before changing who may use the server.
 * A session alone — a phone left unlocked — is not enough for that.
 */
function ConfirmWithYours({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <Field label="Your password" kind="current-password" value={value} onChange={onChange} hint="To confirm it is you." />;
}

function ChangeOwnPassword() {
  const server = useServer();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);

  const invalid = !current || passwordProblem(next, confirm) !== null;

  if (!open) {
    return (
      <Button size="$3" alignSelf="flex-start" onPress={() => setOpen(true)}>
        Change your password
      </Button>
    );
  }

  return (
    <Card gap="$3">
      <Field label="Current password" kind="current-password" value={current} onChange={setCurrent} autoFocus />
      <Field label="New password" kind="new-password" value={next} onChange={setNext} hint={`At least ${PASSWORD_MIN} characters.`} />
      <Field label="New password again" kind="new-password" value={confirm} onChange={setConfirm} />
      {message ? (
        <Text fontSize={13} color={message.tone === 'danger' ? '$danger' : '$success'} lineHeight={18} role="alert">
          {message.text}
        </Text>
      ) : null}
      <XStack gap="$2">
        <Button flex={1} size="$3" disabled={busy} onPress={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          flex={1}
          size="$3"
          backgroundColor="$accent"
          color="$background"
          disabled={busy || invalid}
          opacity={busy || invalid ? 0.5 : 1}
          onPress={async () => {
            haptic();
            setBusy(true);
            setMessage(null);
            try {
              await server.auth.changePassword(current, next);
              setCurrent('');
              setNext('');
              setConfirm('');
              setMessage({ tone: 'success', text: 'Changed. Every other device signed in as you has been signed out.' });
            } catch (error) {
              setMessage({ tone: 'danger', text: describeError(error) });
            } finally {
              setBusy(false);
            }
          }}
        >
          Change password
        </Button>
      </XStack>
    </Card>
  );
}
