import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, type TransportList } from '@kraftverk/api-client';
import { Card, Row, RowSeparator, SectionLabel, Icon } from '@kraftverk/ui';

import { Screen } from '../src/components/Screen';
import { HERE } from '../src/platform/here';
import { useHome } from '../src/state/HomeProvider';

/**
 * What devices are reached over, by whom (docs/ARCHITECTURE.md §4.7).
 *
 * The home's transports — a server's MQTT broker, its Bluetooth radio, the
 * home network; or, with no server, this browser's or phone's own — each with
 * whether it runs and why not, and its own read-only diagnostics. Then, with
 * a server, what this app can hold a connection over itself. Nothing here
 * names a device, and on screen this is "connectivity": the app never says
 * transport (§2).
 */
export default function ConnectivityScreen() {
  const { api, kind, holding } = useHome();
  const [list, setList] = useState<TransportList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();
  // The home's own, and — with a server — this app's, which it holds the server's ways over.
  const theirs = list?.transports.filter((transport) => transport.holder === 'master') ?? [];
  const mine = list?.transports.filter((transport) => transport.holder === 'this-node') ?? [];

  useEffect(() => {
    let live = true;
    api.transports
      .list()
      .then((found) => live && setList(found))
      .catch((err: unknown) => live && setError(describeError(err) || 'It did not say what it can reach'));
    return () => {
      live = false;
    };
  }, [api]);

  return (
    <Screen back="App settings" backTo="/app-settings" title="Connectivity" subtitle="How devices are reached">
      <YStack gap="$2">
        <SectionLabel>{kind === 'server' ? 'Your server' : capitalise(HERE)}</SectionLabel>
        {error ? (
          <Card borderColor="$danger">
            <Text fontSize={13} color="$danger">
              {error}
            </Text>
          </Card>
        ) : null}
        {!list && !error ? <Spinner color="$accent" /> : null}
        {theirs.map((transport) => (
          <Card key={transport.id} gap="$2">
            <XStack alignItems="center" gap="$2">
              <Icon
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

      {kind === 'server' && list ? (
        <YStack gap="$2">
          <SectionLabel>This app, for your server</SectionLabel>
          <Card inset>
            {holding ? (
              <Row
                title={`Not held in ${HERE} now`}
                subtitle={holding.problem}
                accessory={
                  holding.takeOver ? (
                    <Button size="$2" onPress={holding.takeOver}>
                      Use it here
                    </Button>
                  ) : undefined
                }
              />
            ) : mine.length === 0 ? (
              <Row title={`Nothing in ${HERE}`} subtitle="This app cannot hold a way itself here" />
            ) : null}
            {holding
              ? null
              : mine.map((transport, index) => (
                  <YStack key={transport.id}>
                    {index > 0 ? <RowSeparator /> : null}
                    <Row title={capitalise(transport.label)} subtitle={transport.availability.ok ? 'Available here' : transport.availability.reason} />
                  </YStack>
                ))}
          </Card>
        </YStack>
      ) : null}
    </Screen>
  );
}

/** A transport's read-only diagnostics, one at a time, as the transport reports them. */
function Diagnostics({ transport, names }: { transport: string; names: string[] }) {
  const { api } = useHome();
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
        const data = await api.transports.diagnostic(transport, name, { limit: '50' });
        setShown({ name, body: JSON.stringify(data, null, 2) });
      } catch (err) {
        setShown({ name, body: describeError(err) || 'It did not answer' });
      } finally {
        setBusy(false);
      }
    },
    [api, shown, transport]
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
