import { useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button, Input, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, Row, RowSeparator, SectionLabel, haptic } from '@kraftverk/ui';
import {
  describeError,
  fetchResetAvailability,
  fetchVersion,
  getApiBaseUrl,
  resetDatabase,
} from '@kraftverk/api-client';
import type { VersionInfo } from '@kraftverk/api-client';

import { completeUrl } from '../src/lib/servers';
import { Pressable } from '../src/components/Pressable';
import { Screen } from '../src/components/Screen';
import { useDevices } from '../src/state/DevicesProvider';
import { useDirectLink } from '../src/state/DirectLinkProvider';

/**
 * The app's own settings, as distinct from a device's.
 *
 * Everything here is infrastructure: which drivers are installed, and how the
 * server reaches hardware. None of it is a thing you own, so none of it belongs
 * on the device canvas — people add a plug, not a plugin.
 *
 * This is deliberately one level down. A user who never installs an extension
 * never has to come here, and the primary navigation stays the list of devices.
 */
export default function AppSettingsScreen() {
  const { source, version: linkVersion } = useDirectLink();
  const { editable } = useDevices();
  const theme = useTheme();

  /*
    The server's own version, asked for here and nowhere else. It used to arrive
    with every station poll, which is how a fact about the server ended up
    inside the station's state — and why the P280's screens read it to decide
    whether writes were allowed. That belongs to a device's connection now.
  */
  const [served, setServed] = useState<VersionInfo | null>(null);

  useEffect(() => {
    if (!editable) return;
    const controller = new AbortController();
    void fetchVersion(controller.signal)
      .then(setServed)
      .catch(() => undefined);
    return () => controller.abort();
  }, [editable]);

  const version = editable ? served : linkVersion;

  const chevron = <Feather name="chevron-right" size={16} color={theme.muted?.val} />;

  return (
    <Screen back="Your devices" title="App settings" subtitle="Drivers, links and this install">
      <YStack gap="$2">
        <SectionLabel>Infrastructure</SectionLabel>
        <Card inset>
          {/*
            Extensions are loaded by a server process, so in local mode there is
            nothing to show and nowhere for the row to lead. Hiding it beats a
            screen that can only apologise.
          */}
          {editable ? (
            <>
              <Pressable onPress={() => router.push('/extensions')}>
                <Row
                  title="Extensions"
                  subtitle="Drivers and services the server can load. You add a device, not a driver."
                  accessory={chevron}
                />
              </Pressable>
              <RowSeparator />
            </>
          ) : null}
          <Pressable onPress={() => router.push('/link')}>
            <Row
              title="Station link"
              subtitle={
                source === 'direct'
                  ? 'This app holds the station’s Bluetooth connection'
                  : 'How the server finds and binds a power station'
              }
              accessory={chevron}
            />
          </Pressable>
        </Card>
      </YStack>

      <Servers />

      <YStack gap="$2">
        <SectionLabel>This install</SectionLabel>
        <Card inset>
          <Row
            title="Mode"
            subtitle={
              editable
                ? 'A server holds your devices, their history and their links'
                : 'Local only — this device holds its own links, and nothing is stored'
            }
            accessory={
              <Text fontSize={13} color="$muted">
                {editable ? 'Server' : 'Local'}
              </Text>
            }
          />
          {/* Only meaningful when there is a server; in local mode there is none. */}
          {editable ? (
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

      {editable ? <ResetEverything /> : null}
    </Screen>
  );
}

/**
 * The kraftverk servers this app knows about.
 *
 * The app works with no server: it can hold a station's Bluetooth link itself.
 * A server is what adds the things only an always-on process can do — history,
 * background sampling, and eventually automations — so it is something you add
 * by address and can forget again, rather than a fact compiled into the build.
 *
 * "Local only" is a first-class choice here, not the failure state it looked
 * like when the app assumed a server and shouted when one was missing.
 */
function Servers() {
  const { servers } = useDirectLink();
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
            subtitle="This device holds its own links over Bluetooth. No history, and nothing runs while the app is closed."
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
 * history, plugin configuration and secrets, capability grants, and the audit
 * timeline that would otherwise be the record of it happening.
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
      'Every device, all recorded history, plugin configuration and secrets will be deleted. ' +
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
      'Every device, all recorded history, plugin configuration and secrets will be deleted. ' +
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
              Removes every device, all recorded history, plugin configuration and secrets, and the
              audit timeline. The server keeps running and comes back as a blank canvas.
            </Text>
          </YStack>

          <XStack gap="$2">
            <Input
              flex={1}
              size="$3"
              value={secret}
              placeholder="Reset passphrase"
              secureTextEntry
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
            To allow this app to empty the database, write a passphrase of at least 8 characters to
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

