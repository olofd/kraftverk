import { Button, Spinner, useTheme, YStack } from 'tamagui';

import type { Holder } from '@kraftverk/api-client';
import { Card, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { Pressable } from '../../components/Pressable';
import { useHome } from '../../state/HomeProvider';
import { useReach } from '../../state/useReach';

/** One way to connect, and who would hold it. */
export type Way = { methodId: string; label: string; description?: string; holder: Holder; available: boolean; reason: string | null; recommended: boolean };

// --- 3 · how do you want to connect -------------------------------------------------

export function Ways({ ways, busy, onPick, onBack }: { ways: Way[]; busy: boolean; onPick: (way: Way) => void; onBack?: () => void }) {
  const theme = useTheme();
  const { role } = useHome();
  const reach = useReach();
  return (
    <YStack gap="$2">
      <SectionLabel>How do you want to connect?</SectionLabel>
      <Card inset>
        {ways.length === 0 ? (
          <Row title="No way to reach it from here" subtitle={role === 'follower' ? 'Neither your server nor this app has what it needs' : 'This app has nothing that reaches it'} />
        ) : null}
        {ways.map((way, index) => (
          <YStack key={`${way.methodId}-${way.holder}`}>
            {index > 0 ? <RowSeparator /> : null}
            <Pressable disabled={busy || !way.available} onPress={() => onPick(way)}>
              <Row
                title={`${way.label}${way.recommended ? ' · recommended' : ''}`}
                subtitle={way.available ? way.description : (way.reason ?? 'Not available here')}
                disabled={!way.available}
                accessory={<Icon name={reach.holder(way.holder).icon} size={16} color={theme.muted?.val} />}
              />
            </Pressable>
          </YStack>
        ))}
      </Card>
      {busy ? <Spinner color="$accent" /> : null}
      {onBack ? (
        <Button alignSelf="flex-start" size="$2" onPress={onBack}>
          Back
        </Button>
      ) : null}
    </YStack>
  );
}
