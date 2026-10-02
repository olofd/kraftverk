import { Button, Spinner, Text, YStack } from 'tamagui';

import { Card, haptic, Row } from '@kraftverk/ui';

import type { Opening } from '../state/HomeProvider';
import { useServers } from '../state/ServersProvider';
import { Pressable } from './Pressable';

/** While the home opens: a spinner, and nothing else. */
export function Waiting() {
  return (
    <YStack flex={1} alignItems="center" justifyContent="center" backgroundColor="$background">
      <Spinner color="$accent" />
    </YStack>
  );
}

/** What stands in for the app while its own home is not open here: opening, held by another tab, or why it cannot be. */
export function NotOpen({ state, onTakeOver, onRetry }: { state: Opening; onTakeOver: () => void; onRetry: () => void }) {
  const servers = useServers();
  if (state.status === 'opening' || state.status === 'open') return <Waiting />;
  const [title, detail, action] =
    state.status === 'elsewhere'
      ? (['Open in another tab', 'This browser keeps its home in one tab at a time, and another tab has it open now.', 'Use it here'] as const)
      : state.status === 'handed-over'
        ? (['Open in another tab now', 'Another tab of this browser asked for this home, and has it now.', 'Use it here again'] as const)
        : (['This home could not open', state.message, 'Try again'] as const);
  return (
    <YStack flex={1} backgroundColor="$background" alignItems="center" justifyContent="center" padding="$4">
      <YStack width="100%" maxWidth={420} gap="$4">
        <Card gap="$3">
          <Text role="heading" fontSize={18} fontWeight="700" color="$color">
            {title}
          </Text>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {detail}
          </Text>
          <Button
            size="$3"
            backgroundColor="$accent"
            color="$background"
            onPress={() => {
              haptic();
              if (state.status === 'failed') onRetry();
              else onTakeOver();
            }}
          >
            {action}
          </Button>
        </Card>
        {servers.all.length ? (
          <Card inset>
            {servers.all.map((server) => (
              <Pressable key={server.id} onPress={() => servers.use(server.id)}>
                <Row title={`Use ${server.name}`} subtitle={server.url} />
              </Pressable>
            ))}
          </Card>
        ) : null}
      </YStack>
    </YStack>
  );
}
