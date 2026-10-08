import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Button, Text, YStack } from 'tamagui';

import { PASSWORD_MIN } from '@kraftverk/api-contract';
import { Card, haptic, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { useAttempt } from '../../components/useAttempt';
import { useAuth } from '../../state/AuthProvider';
import { useServers } from '../../state/ServersProvider';
import { JoinFamily } from '../account/JoinFamily';
import { Field, passwordProblem } from './fields';

export function SignIn() {
  const { state } = useAuth();
  const servers = useServers();
  const server = servers.active;

  const mode = state?.setupRequired ? (state.canSetup ? 'setup' : 'setup-elsewhere') : 'login';

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1 }} style={{ flex: 1 }}>
      <YStack flex={1} backgroundColor="$background" alignItems="center" justifyContent="center" padding="$4" gap="$4">
        <YStack width="100%" maxWidth={420} gap="$4">
          <YStack gap="$1.5">
            <Text fontSize={26} fontWeight="800" color="$color">
              {mode === 'login' ? 'Log in' : 'Set up this server'}
            </Text>
            <Text fontSize={13} color="$muted" lineHeight={19}>
              {server ? `${server.name} · ${server.url}` : ''}
            </Text>
          </YStack>

          {mode === 'login' ? <LoginForm /> : mode === 'setup' ? <SetupForm /> : <SetupElsewhere />}

          {/* Invited, with no password here: the invitation lets this device's account in, and its key signs in from then. */}
          {mode === 'login' ? (
            <YStack gap="$2">
              <SectionLabel>Or, invited</SectionLabel>
              <JoinFamily />
            </YStack>
          ) : null}

          <WayOut />
        </YStack>
      </YStack>
    </ScrollView>
  );
}

/** Username and password, for an existing account. */
function LoginForm({ submitLabel = 'Log in' }: { submitLabel?: string }) {
  const { logIn, notice } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error: problem, attempt } = useAttempt();
  const shown = problem ?? notice;

  const submit = async () => {
    if (!username.trim() || !password || busy) return;
    await attempt(async () => {
      await logIn(username.trim(), password);
      setPassword('');
    }, 'Could not log in');
  };

  return (
    <Card gap="$3">
      <Field label="Username" kind="username" value={username} onChange={setUsername} autoFocus />
      <Field label="Password" kind="current-password" value={password} onChange={setPassword} onSubmit={() => void submit()} />
      {shown ? (
        <ErrorText>
          {shown}
        </ErrorText>
      ) : null}
      <Button
        size="$3"
        backgroundColor="$accent"
        color="$background"
        disabled={busy || !username.trim() || !password}
        opacity={busy || !username.trim() || !password ? 0.5 : 1}
        onPress={() => {
          haptic();
          void submit();
        }}
      >
        {busy ? 'Checking…' : submitLabel}
      </Button>
    </Card>
  );
}

function SetupForm() {
  const { setup } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error: problem, attempt } = useAttempt();

  const invalid = !username.trim() || passwordProblem(password, confirm) !== null;

  const submit = async () => {
    if (invalid || busy) return;
    await attempt(async () => {
      await setup(username.trim(), password);
    }, 'Could not create the account');
  };

  return (
    <YStack gap="$3">
      <Text fontSize={13} color="$muted" lineHeight={19}>
        This server has no accounts yet. Create the first one now: it is an administrator, and everyone
        signs in to use this server — at home and away, you and anyone you add later. The first account
        can only be created from the home network, which is where you are.
      </Text>
      <Card gap="$3">
        <Field label="Username" kind="username" value={username} onChange={setUsername} autoFocus />
        <Field
          label="Password"
          kind="new-password"
          value={password}
          onChange={setPassword}
          hint={`At least ${PASSWORD_MIN} characters. A password manager’s suggestion is ideal — this may be all that stands between the internet and your devices.`}
        />
        <Field label="Password again" kind="new-password" value={confirm} onChange={setConfirm} onSubmit={() => void submit()} />
        {password && confirm && passwordProblem(password, confirm) ? (
          <Text fontSize={12} color="$warning">
            {passwordProblem(password, confirm)}
          </Text>
        ) : null}
        {problem ? (
          <ErrorText>
            {problem}
          </ErrorText>
        ) : null}
        <Button
          size="$3"
          backgroundColor="$accent"
          color="$background"
          disabled={busy || invalid}
          opacity={busy || invalid ? 0.5 : 1}
          onPress={() => {
            haptic();
            void submit();
          }}
        >
          {busy ? 'Creating…' : 'Create administrator'}
        </Button>
      </Card>
    </YStack>
  );
}

function SetupElsewhere() {
  const { state, refresh } = useAuth();
  return (
    <Card gap="$3">
      <Text fontSize={14} fontWeight="700" color="$color">
        Finish setting up at home
      </Text>
      <Text fontSize={13} color="$muted" lineHeight={19}>
        This server has no accounts yet, and the first one can only be created from the home network —
        so that nobody who finds it on the internet can claim it before you do. Open the app on a device
        at home, create the administrator there, and then log in here.
      </Text>
      {state?.reason ? (
        <Text fontSize={12} color="$muted" lineHeight={17}>
          How the server sees this device: {state.reason}.
        </Text>
      ) : null}
      <Button size="$3" onPress={() => void refresh()}>
        Check again
      </Button>
    </Card>
  );
}

/** Another saved server, or none. Never trapped behind a login you cannot give. */
function WayOut() {
  const servers = useServers();
  const others = servers.all.filter((server) => server.id !== servers.active?.id);

  return (
    <YStack gap="$2">
      <SectionLabel>Or</SectionLabel>
      <Card inset>
        {others.map((server) => (
          <YStack key={server.id}>
            <Pressable onPress={() => servers.use(server.id)}>
              <Row title={`Use ${server.name}`} subtitle={server.url} />
            </Pressable>
            <RowSeparator />
          </YStack>
        ))}
        <Pressable onPress={() => servers.use(null)}>
          <Row title="Use without a server" subtitle="This app keeps its own devices, their history and their automations, while it is open" />
        </Pressable>
      </Card>
    </YStack>
  );
}
