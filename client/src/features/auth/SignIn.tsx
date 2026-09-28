import { useState } from 'react';
import { ScrollView } from 'react-native';
import { Button, Spinner, Text, YStack } from 'tamagui';

import { Card, Row, RowSeparator, SectionLabel, haptic } from '@kraftverk/ui';
import { describeError } from '@kraftverk/api-client';

import { Pressable } from '../../components/Pressable';
import { useAuth } from '../../state/AuthProvider';
import { useServers } from '../../state/ServersProvider';
import { Field, passwordProblem, PASSWORD_MIN } from './fields';

/**
 * What stands in for the app when the chosen server wants to know who you are.
 *
 * Three cases, and each says plainly which one it is:
 *
 * - **Sign in** — the server has accounts. Every device signs in, at home too:
 *   devices belong to accounts, and a visitor with no account has no view.
 * - **Create the first administrator** — a fresh server, reached from the home
 *   network. Accounts are what make it reachable from outside.
 * - **Set it up at home** — a fresh server reached from outside. Nothing can be
 *   done from here, deliberately: a server exposed to the internet before
 *   anyone has an account must not be claimable by whoever finds it first.
 *
 * Always with a way out — another saved server, or no server at all — because
 * a login screen you cannot leave is a trap, not a lock.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const { applies, loading, allowed, state, generation } = useAuth();
  const blocked = applies && !allowed;

  /*
    Drawn over the app, never instead of it.

    Swapping the navigator out for a sign-in screen unmounts it, and a
    navigator mounted again starts from its home route — so every deep link
    and bookmark to a device, and wherever you were when a session expired, was
    lost. The device list does not poll while this is up, and the server
    enforces access regardless; this is presentation, and presentation should
    not cost the user their place.

    Except when the person changes. Signing out, or another account signing
    in, throws the tree underneath away (`generation`): otherwise the last
    account's devices, readings and account list would stay in memory and in
    the page, readable with the developer tools by whoever sits down next. A
    session that merely expired keeps its place — it is the same person.
  */
  return (
    <YStack flex={1}>
      {/*
        Hidden, not covered: an overlay alone leaves the screen underneath
        readable by a screen reader and reachable with Tab. `display: none`
        keeps it mounted — and the navigator with it — but out of sight,
        focus and the accessibility tree.
      */}
      <YStack key={generation} flex={1} display={blocked ? 'none' : 'flex'}>
        {children}
      </YStack>
      {blocked ? (
        <YStack position="absolute" top={0} right={0} bottom={0} left={0} backgroundColor="$background" zIndex={1000}>
          {loading || !state ? (
            <YStack flex={1} alignItems="center" justifyContent="center">
              <Spinner color="$accent" />
            </YStack>
          ) : (
            <SignIn />
          )}
        </YStack>
      ) : null}
    </YStack>
  );
}

function SignIn() {
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

          <WayOut />
        </YStack>
      </YStack>
    </ScrollView>
  );
}

/** Username and password, for an existing account. */
export function LoginForm({ submitLabel = 'Log in' }: { submitLabel?: string }) {
  const { logIn, notice } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const shown = problem ?? notice;

  const submit = async () => {
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await logIn(username.trim(), password);
      setPassword('');
    } catch (error) {
      setProblem(describeError(error) || 'Could not log in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card gap="$3">
      <Field label="Username" kind="username" value={username} onChange={setUsername} autoFocus />
      <Field label="Password" kind="current-password" value={password} onChange={setPassword} onSubmit={() => void submit()} />
      {shown ? (
        <Text fontSize={13} color="$danger" lineHeight={18} role="alert">
          {shown}
        </Text>
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

export function SetupForm() {
  const { setup } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const invalid = !username.trim() || passwordProblem(password, confirm) !== null;

  const submit = async () => {
    if (invalid || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await setup(username.trim(), password);
    } catch (error) {
      setProblem(describeError(error) || 'Could not create the account');
    } finally {
      setBusy(false);
    }
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
          hint={`At least ${PASSWORD_MIN} characters. A password manager’s suggestion is ideal — this may be all that stands between the internet and your station.`}
        />
        <Field label="Password again" kind="new-password" value={confirm} onChange={setConfirm} onSubmit={() => void submit()} />
        {password && confirm && passwordProblem(password, confirm) ? (
          <Text fontSize={12} color="$warning">
            {passwordProblem(password, confirm)}
          </Text>
        ) : null}
        {problem ? (
          <Text fontSize={13} color="$danger" lineHeight={18} role="alert">
            {problem}
          </Text>
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
          <Row title="Use without a server" subtitle="Local mode: this device holds its own Bluetooth links" />
        </Pressable>
      </Card>
    </YStack>
  );
}
