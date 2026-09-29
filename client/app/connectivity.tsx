import { useCallback, useEffect, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, fetchTransportDiagnostic, fetchTransports, type TransportList } from '@kraftverk/api-client';
import { Card, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { Screen } from '../src/components/Screen';
import { PLATFORM } from '../src/runtime/registry';
import { useDevices } from '../src/state/DevicesProvider';

/**
 * What devices are reached over, by whom (docs/ARCHITECTURE.md §4.7).
 *
 * The server's transports — the MQTT broker stations connect to, its
 * Bluetooth radio, the home network — each with whether it runs and why not,
 * and its own read-only diagnostics. Then this app's: what it can hold a
 * connection over, where it runs. Nothing here names a device, and on screen
 * this is "connectivity": the app never says transport (§2).
 */
export default function ConnectivityScreen() {
  const { mode, runtime } = useDevices();
  const [list, setList] = useState<TransportList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();

  useEffect(() => {
    if (mode !== 'server') return;
    fetchTransports()
      .then(setList)
      .catch((err: unknown) => setError(describeError(err) || 'The server did not say what it can reach'));
  }, [mode]);

  const here = runtime.registry.held();

  return (
    <Screen back="App settings" backTo="/app-settings" title="Connectivity" subtitle="How devices are reached">
      {mode === 'server' ? (
        <YStack gap="$2">
          <SectionLabel>Your server</SectionLabel>
          {error ? (
            <Card borderColor="$danger">
              <Text fontSize={13} color="$danger">
                {error}
              </Text>
            </Card>
          ) : null}
          {!list && !error ? <Spinner color="$accent" /> : null}
          {list?.transports.map((transport) => (
            <Card key={transport.id} gap="$2">
              <XStack alignItems="center" gap="$2">
                <Feather
                  name={transport.availability.ok ? 'check-circle' : 'alert-circle'}
                  size={16}
                  color={transport.availability.ok ? theme.success?.val : theme.warning?.val}
                />
                <Text flex={1} fontSize={15} fontWeight="700" color="$color">
                  {capitalise(transport.label)}
                </Text>
              </XStack>
              <Text fontSize={12} color="$muted" lineHeight={18}>
                {transport.availability.ok ? 'Running.' : transport.availability.reason}
                {Object.keys(transport.values).length ? ` ${Object.entries(transport.values).map(([key, value]) => `${key}: ${value}`).join(' · ')}` : ''}
              </Text>
              {transport.diagnostics.length ? <Diagnostics transport={transport.id} names={transport.diagnostics} /> : null}
            </Card>
          ))}
          {list?.refused.length ? (
            <Card borderColor="$warning" gap="$1">
              {list.refused.map((refusal) => (
                <Text key={refusal.source} fontSize={12} color="$warning">
                  {refusal.source}: {refusal.problems.join('; ')}
                </Text>
              ))}
            </Card>
          ) : null}
        </YStack>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>This app</SectionLabel>
        <Card inset>
          {here.length === 0 ? <Row title={`Nothing ${PLATFORM === 'web' ? 'in this browser' : 'in this app'}`} subtitle="This app cannot hold a connection itself here" /> : null}
          {here.map((id, index) => {
            const available = runtime.registry.available(id);
            const definition = runtime.registry.definition(id)!;
            return (
              <YStack key={id}>
                {index > 0 ? <RowSeparator /> : null}
                <Row title={capitalise(definition.label)} subtitle={available.ok ? 'Available here' : available.reason} />
              </YStack>
            );
          })}
        </Card>
      </YStack>
    </Screen>
  );
}

/** A transport's read-only diagnostics, one at a time, as the transport reports them. */
function Diagnostics({ transport, names }: { transport: string; names: string[] }) {
  const [shown, setShown] = useState<{ name: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const show = useCallback(
    async (name: string) => {
      if (shown?.name === name) {
        setShown(null);
        return;
      }
      setBusy(true);
      try {
        const data = await fetchTransportDiagnostic(transport, name, { limit: 50 });
        setShown({ name, body: JSON.stringify(data, null, 2) });
      } catch (err) {
        setShown({ name, body: describeError(err) || 'It did not answer' });
      } finally {
        setBusy(false);
      }
    },
    [shown, transport]
  );

  return (
    <YStack gap="$2">
      <XStack gap="$2" flexWrap="wrap">
        {names.map((name) => (
          <Button key={name} size="$2" disabled={busy} onPress={() => void show(name)}>
            {shown?.name === name ? `Hide ${name}` : name}
          </Button>
        ))}
      </XStack>
      {shown ? (
        <Text fontSize={11} fontFamily="$mono" color="$color" lineHeight={16} userSelect="text">
          {shown.body.length > 20_000 ? `${shown.body.slice(0, 20_000)}\n…` : shown.body}
        </Text>
      ) : null}
    </YStack>
  );
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
