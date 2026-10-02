import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, type NodeView, type TransportList } from '@kraftverk/api-client';
import { Card, formatAgo, Row, RowSeparator, SectionLabel, Icon } from '@kraftverk/ui';

import { Screen } from '../src/components/Screen';
import { confirmAction } from '../src/lib/confirm';
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
  const { api, role, holding } = useHome();
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
      <Nodes labels={Object.fromEntries((list?.transports ?? []).map((transport) => [transport.id, transport.label]))} />

      <YStack gap="$2">
        <SectionLabel>{role === 'follower' ? 'Your server' : capitalise(HERE)}</SectionLabel>
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

      {role === 'follower' && list ? (
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

/**
 * The kraftverk nodes of the home (docs/DATA-MODEL.md §3): every place
 * kraftverk runs — your server, this browser, a phone — with what each is,
 * as it declares it: the one that keeps the home (its master), and the ones
 * that follow it, holding what they reach themselves. A node you joined from
 * another browser or phone can be forgotten, with every way it held.
 */
function Nodes({ labels }: { labels: Record<string, string> }) {
  const { api, nodeId } = useHome();
  const [nodes, setNodes] = useState<NodeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let live = true;
    api.nodes
      .list()
      .then((found) => {
        if (!live) return;
        setNodes(found);
        setError(null);
      })
      .catch((err: unknown) => live && setError(describeError(err) || 'It did not say which nodes it has'));
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(load, [load]);

  const forget = async (node: NodeView) => {
    const yes = await confirmAction(`Forget ${node.name}?`, `Every way to reach a device it held goes with it. It joins again the next time it opens.`, 'Forget', 'dangerous');
    if (!yes) return;
    try {
      await api.nodes.forget(node.id);
      load();
    } catch (err) {
      setError(describeError(err) || 'It was not forgotten');
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Kraftverk nodes</SectionLabel>
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger">
            {error}
          </Text>
        </Card>
      ) : null}
      {!nodes && !error ? <Spinner color="$accent" /> : null}
      {nodes?.length ? (
        <Card inset>
          {nodes.map((node, index) => (
            <YStack key={node.id}>
              {index > 0 ? <RowSeparator /> : null}
              <Row
                title={node.id === nodeId ? `${node.name} · this one` : node.name}
                subtitle={[
                  node.master ? 'Keeps your home: its devices, history and automations' : 'Follows it, holding what it reaches itself',
                  traitWords(node),
                  node.transports.length ? `Reaches over ${node.transports.map((id) => labels[id] ?? id).join(', ')}` : null,
                  // When a follower last said who it is: the master and this one are here now.
                  node.master || node.id === nodeId ? null : `Heard ${formatAgo(node.lastSeenAt)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                accessory={
                  node.yours && node.id !== nodeId ? (
                    <Button size="$2" onPress={() => void forget(node)}>
                      Forget
                    </Button>
                  ) : undefined
                }
              />
            </YStack>
          ))}
        </Card>
      ) : null}
    </YStack>
  );
}

/** What a node declares it is, in a person's words. */
const traitWords = (node: Pick<NodeView, 'alwaysOn' | 'reachable' | 'trusted'>): string =>
  [node.alwaysOn ? 'always on' : 'on while open', node.reachable ? 'others connect to it' : null, node.trusted ? 'trusted with passwords' : null].filter(Boolean).join(', ').replace(/^./, (first) => first.toUpperCase());

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
