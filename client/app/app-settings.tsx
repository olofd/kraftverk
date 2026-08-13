import { useEffect, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button, Input, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, Row, RowSeparator, SectionLabel, haptic } from '@kraftverk/ui';
import { getApiBaseUrl, fetchVersion } from '@kraftverk/api-client';
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

