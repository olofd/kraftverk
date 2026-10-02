import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner, YStack } from 'tamagui';

import { describeError, type NodeView } from '@kraftverk/api-client';
import { Card, formatAgo, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { confirmAction } from '../../platform/confirm';
import { useHome } from '../../state/HomeProvider';

/**
 * The kraftverk nodes of the home (docs/DATA-MODEL.md §3): every place
 * kraftverk runs — your server, this browser, a phone — with what each is,
 * as it declares it: the one that keeps the home (its master), and the ones
 * that follow it, holding what they reach themselves. A node you joined from
 * another browser or phone can be forgotten, with every way it held.
 */
export function Nodes({ labels }: { labels: Record<string, string> }) {
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
          <ErrorText>
            {error}
          </ErrorText>
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
