import { useState } from 'react';
import { Button, Input, Text, useTheme, XStack, YStack } from 'tamagui';

import { completeUrl } from '@kraftverk/api-client';
import { Card, haptic, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { Pressable } from '../../components/Pressable';
import { API_PORT } from '../../platform/server-address';
import { useServers } from '../../state/ServersProvider';

/**
 * The kraftverk servers this app knows about, and the one it follows.
 *
 * The app works with no server: its own node keeps its home. A server is
 * what adds what only an always-on node can do — history and automations
 * while the app is closed — so it is something you add by address and can
 * forget again, rather than a fact compiled into the build.
 *
 * "No server" is a first-class choice here, not the failure state it looked
 * like when the app assumed a server and shouted when one was missing.
 */
export function Servers() {
  const servers = useServers();
  const theme = useTheme();

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    const url = completeUrl(draft, API_PORT);
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
            title="No server"
            subtitle="This app keeps your home: its devices, their history and their automations, and every connection. Nothing runs while the app is closed."
            accessory={
              servers.active ? null : <Icon name="check" size={16} color={theme.accent?.val} />
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
                      <Icon name="check" size={16} color={theme.accent?.val} />
                    ) : null}
                    <Button
                      size="$2"
                      borderColor="$danger"
                      icon={<Icon name="trash-2" size={12} color={theme.danger?.val} />}
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
            aria-label="The server's address"
            autoCapitalize="none"
            onChangeText={setDraft}
            onSubmitEditing={() => (!busy && draft.trim() ? void save() : undefined)}
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
          icon={<Icon name="plus" size={14} color={theme.color?.val} />}
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
