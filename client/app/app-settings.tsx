import { useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button, Input, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, Row, RowSeparator, SectionLabel, ToggleRow, haptic } from '@kraftverk/ui';
import { describeError, fetchResetAvailability, getApiBaseUrl, resetDatabase } from '@kraftverk/api-client';

import { completeUrl } from '../src/lib/servers';
import { Pressable } from '../src/components/Pressable';
import { Screen } from '../src/components/Screen';
import { useAuth } from '../src/state/AuthProvider';
import { useDevices } from '../src/state/DevicesProvider';
import { useServers } from '../src/state/ServersProvider';

/**
 * The app's own settings, as distinct from a device's: which server, who may
 * use it, what it and this app can reach devices over, and what this app may
 * do itself. None of it is a thing you have, so none of it sits on the device
 * canvas.
 */
export default function AppSettingsScreen() {
  const { mode, version, runtime, removed } = useDevices();
  const auth = useAuth();
  const theme = useTheme();
  const [allowWrites, setAllowWrites] = useState(runtime.allowWrites);
  const chevron = <Feather name="chevron-right" size={16} color={theme.muted?.val} />;

  useEffect(() => runtime.subscribe(() => setAllowWrites(runtime.allowWrites)), [runtime]);

  return (
    <Screen back="Your devices" title="App settings" subtitle="Servers, connectivity and this app">
      <YStack gap="$2">
        <SectionLabel>Infrastructure</SectionLabel>
        <Card inset>
          {mode === 'server' ? (
            <>
              <Pressable onPress={() => router.push('/accounts')}>
                <Row
                  title="Accounts"
                  subtitle={auth.state?.user ? `Signed in as ${auth.state.user.username}. Who may use this server.` : 'Who may use this server'}
                  accessory={chevron}
                />
              </Pressable>
              <RowSeparator />
            </>
          ) : null}
          <Pressable onPress={() => router.push('/connectivity')}>
            <Row
              title="Connectivity"
              subtitle={mode === 'server' ? 'What your server and this app reach devices over, and their diagnostics' : 'What this app can reach devices over'}
              accessory={chevron}
            />
          </Pressable>
          {mode === 'server' ? (
            <>
              <RowSeparator />
              <Pressable onPress={() => router.push('/removed')}>
                <Row title="Removed devices" subtitle={removed.length ? `${removed.length} kept with their history` : 'None'} accessory={chevron} />
              </Pressable>
              <RowSeparator />
              <Pressable onPress={() => router.push('/server-log')}>
                <Row title="Server log" subtitle="What the server has said lately — where to look when something is wrong" accessory={chevron} />
              </Pressable>
            </>
          ) : null}
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>This app</SectionLabel>
        <Card inset>
          {/*
            Off on every launch, on purpose: a phone in a pocket should not be
            the easiest way to change a station's settings or cut its mains.
          */}
          <ToggleRow
            title="Allow writes from this app"
            subtitle="For devices this app holds itself. Off every time the app starts: until then, it only reads."
            checked={allowWrites}
            onCheckedChange={(next) => {
              haptic();
              runtime.setAllowWrites(next);
            }}
          />
          {mode === 'server' ? (
            <>
              <RowSeparator />
              <Row title="Known to the server as" subtitle={runtime.clientId ? `App ${runtime.clientId}` : 'Not registered yet'} />
            </>
          ) : null}
        </Card>
      </YStack>

      <Servers />

      <YStack gap="$2">
        <SectionLabel>This install</SectionLabel>
        <Card inset>
          <Row
            title="Mode"
            subtitle={mode === 'server' ? 'A server keeps your devices, their history and their links' : 'Local — this app keeps its own devices and holds every connection; nothing is recorded'}
            accessory={
              <Text fontSize={13} color="$muted">
                {mode === 'server' ? 'Server' : 'Local'}
              </Text>
            }
          />
          {mode === 'server' ? (
            <>
              <RowSeparator />
              <Row
                title="Server version"
                subtitle={getApiBaseUrl()}
                accessory={
                  <Text fontSize={13} color="$muted">
                    {version ? `v${version.version}` : '—'}
                  </Text>
                }
              />
            </>
          ) : null}
        </Card>
      </YStack>

      {mode === 'server' ? <ResetEverything /> : null}
    </Screen>
  );
}

/**
 * The kraftverk servers this app knows about.
 *
 * The app works with no server: in local mode it keeps its own devices.
 * A server is what adds the things only an always-on process can do — history,
 * background sampling, and eventually automations — so it is something you add
 * by address and can forget again, rather than a fact compiled into the build.
 *
 * "Local only" is a first-class choice here, not the failure state it looked
 * like when the app assumed a server and shouted when one was missing.
 */
function Servers() {
  const servers = useServers();
  const theme = useTheme();

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    const url = completeUrl(draft);
    if (!url) return;

    setBusy(true);
    setProblem(null);
    try {
      // Checked before it is saved: an address that does not answer is worth
      // knowing about while the user still has it in their head.
      if (!(await servers.test(url))) {
        setProblem(`Nothing answered at ${url}. Saved anyway — select it to retry.`);
      }
      await servers.add({ url });
      setDraft('');
      setAdding(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Kraftverk server</SectionLabel>

      <Card inset>
        {/*
          Any change to the list clears the note: it describes one attempt to
          add one address, and it outlived the server it was about — telling
          the user nothing answered at a machine they had just forgotten.
        */}
        <Pressable
          onPress={() => {
            setProblem(null);
            servers.use(null);
          }}
        >
          <Row
            title="Local only"
            subtitle="This app keeps its own devices and holds every connection. No history, and nothing runs while the app is closed."
            accessory={
              servers.active ? null : <Feather name="check" size={16} color={theme.accent?.val} />
            }
          />
        </Pressable>

        {servers.all.map((server) => (
          <YStack key={server.id}>
            <RowSeparator />
            <Pressable
              onPress={() => {
                setProblem(null);
                servers.use(server.id);
              }}
            >
              <Row
                title={server.name}
                subtitle={server.url}
                accessory={
                  <XStack alignItems="center" gap="$2">
                    {servers.active?.id === server.id ? (
                      <Feather name="check" size={16} color={theme.accent?.val} />
                    ) : null}
                    <Button
                      size="$2"
                      borderColor="$danger"
                      icon={<Feather name="trash-2" size={12} color={theme.danger?.val} />}
                      onPress={() => {
                        haptic();
                        setProblem(null);
                        servers.remove(server.id);
                      }}
                    >
                      Forget
                    </Button>
                  </XStack>
                }
              />
            </Pressable>
          </YStack>
        ))}
      </Card>

      {problem ? (
        <Text fontSize={12} color="$warning" lineHeight={18} paddingHorizontal="$1">
          {problem}
        </Text>
      ) : null}

      {adding ? (
        <Card gap="$3">
          <Input
            size="$3"
            autoFocus
            value={draft}
            placeholder="192.168.1.10:3333"
            autoCapitalize="none"
            onChangeText={setDraft}
            backgroundColor="$background"
            borderColor="$borderColor"
          />
          <Text fontSize={12} color="$muted" lineHeight={17}>
            The address of a machine running the kraftverk server. The scheme and the /api suffix
            are filled in for you.
          </Text>
          <XStack gap="$2">
            <Button
              flex={1}
              size="$3"
              disabled={busy}
              onPress={() => {
                setAdding(false);
                setDraft('');
                setProblem(null);
              }}
            >
              Cancel
            </Button>
            <Button
              flex={1}
              size="$3"
              backgroundColor="$accent"
              color="$background"
              disabled={busy || !draft.trim()}
              onPress={() => {
                haptic();
                void save();
              }}
            >
              {busy ? 'Checking…' : 'Add server'}
            </Button>
          </XStack>
        </Card>
      ) : (
        <Button
          size="$3"
          alignSelf="flex-start"
          icon={<Feather name="plus" size={14} color={theme.color?.val} />}
          onPress={() => {
            haptic();
            setAdding(true);
            setDraft('');
          }}
        >
          Add a server
        </Button>
      )}
    </YStack>
  );
}

/**
 * Emptying the database.
 *
 * The blank canvas a fresh install starts from, without asking anyone to find
 * and delete a file on the server. It takes everything: devices, their recorded
 * history, their connections and secrets, their links, and the audit timeline
 * that would otherwise be the record of it happening.
 *
 * Guarded by a passphrase kept in a file on the server, because this API has no
 * authentication of its own and this is the most destructive thing it offers.
 * When no such file exists the control is not shown as a disabled button — it is
 * shown as instructions, because "not enabled" is a thing the user can fix and
 * a greyed-out button does not say how.
 */
function ResetEverything() {
  const { refresh } = useDevices();

  const [availability, setAvailability] = useState<{ available: boolean; secretFile: string } | null>(
    null
  );
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchResetAvailability(controller.signal)
      .then(setAvailability)
      .catch(() => setAvailability(null));
    return () => controller.abort();
  }, []);

  const wipe = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await resetDatabase(secret.trim());
      setSecret('');
      setDone(`Removed ${result.rows} rows across ${result.tables.length} tables.`);
      await refresh();
    } catch (err) {
      setError(describeError(err) || 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const confirmed = () => {
    const message =
      'Every device, all recorded history, every connection and its secrets will be deleted. ' +
      'This cannot be undone.';
    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      return typeof confirm === 'function' && confirm(message);
    }
    return true; // native goes through Alert below
  };

  const ask = () => {
    haptic();
    const message =
      'Every device, all recorded history, every connection and its secrets will be deleted. ' +
      'This cannot be undone.';

    if (Platform.OS === 'web') {
      if (confirmed()) void wipe();
      return;
    }
    Alert.alert('Erase everything?', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Erase', style: 'destructive', onPress: () => void wipe() },
    ]);
  };

  // Nothing to say until the server has answered.
  if (!availability) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>Danger zone</SectionLabel>

      {availability.available ? (
        <Card gap="$3" borderColor="$danger">
          <YStack gap="$2">
            <Text fontSize={15} fontWeight="700" color="$danger">
              Erase everything
            </Text>
            <Text fontSize={13} color="$muted" lineHeight={19}>
              Removes every device, all recorded history, every connection and its secrets, and the
              audit timeline. The server keeps running and comes back as a blank canvas.
            </Text>
          </YStack>

          <XStack gap="$2">
            <Input
              flex={1}
              size="$3"
              value={secret}
              placeholder="Reset passphrase"
              // `type`: Tamagui's web Input ignores `secureTextEntry`, and showed this in the clear.
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              onChangeText={setSecret}
              backgroundColor="$background"
              borderColor="$borderColor"
            />
            <Button
              size="$3"
              borderColor="$danger"
              color="$danger"
              disabled={busy || secret.trim().length === 0}
              onPress={ask}
            >
              {busy ? 'Erasing…' : 'Erase'}
            </Button>
          </XStack>

          {error ? (
            <Text fontSize={12} color="$danger" lineHeight={18}>
              {error}
            </Text>
          ) : null}
          {done ? (
            <Text fontSize={12} color="$muted" lineHeight={18}>
              {done}
            </Text>
          ) : null}
        </Card>
      ) : (
        /*
          Instructions rather than a disabled control. Not being enabled is
          something the user can change, and a greyed-out button would not say
          how — nor that the fix is on the server rather than in the app.
        */
        <Card gap="$2">
          <Text fontSize={15} fontWeight="700" color="$color">
            Erasing is not enabled
          </Text>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            To allow this app to empty the database, write a passphrase of at least 16 characters to
            this file on the server and restart nothing — it is read on each attempt:
          </Text>
          <Text fontSize={12} color="$color" fontFamily="$mono" lineHeight={18}>
            {availability.secretFile}
          </Text>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            The file is gitignored and never leaves the server. Delete it again to switch this off.
          </Text>
        </Card>
      )}
    </YStack>
  );
}

