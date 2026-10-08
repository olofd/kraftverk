import { Button, Spinner, useTheme, YStack } from 'tamagui';

import type { HeldBy } from '@kraftverk/api-client';
import { Card, Icon, Row, RowSeparator, SectionLabel } from '@kraftverk/ui';

import { Pressable } from '../../components/Pressable';
import { useFamily } from '../../state/FamilyProvider';
import { useReach } from '../../state/useReach';

/** One way to connect, and who would hold it. */
export type Way = {
  methodId: string;
  label: string;
  description?: string;
  /** How far it reaches and how what it says arrives, in words. */
  reaches: string;
  holder: HeldBy;
  available: boolean;
  reason: string | null;
  recommended: boolean;
  /** What it is reached through and you do not have yet — an account, a gateway: set up first, from here. */
  needs?: { typeId: string; name: string; kind: string };
};

/** The step a way needing an account or a gateway offers: in the words of what it needs. */
const needSaid = (need: NonNullable<Way['needs']>): string => (need.kind === 'account' ? `Sign in to your ${need.name} first` : `Set up your ${need.name} first`);

// --- 3 · how do you want to connect -------------------------------------------------

export function Ways({ ways, busy, onPick, onNeed, onBack }: { ways: Way[]; busy: boolean; onPick: (way: Way) => void; onNeed: (need: NonNullable<Way['needs']>) => void; onBack?: () => void }) {
  const theme = useTheme();
  const { role } = useFamily();
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
            {way.needs ? (
              <Pressable disabled={busy} onPress={() => onNeed(way.needs!)}>
                <Row
                  title={way.label}
                  subtitle={`${needSaid(way.needs)}: what is on it is found, and this among it`}
                  accessory={<Icon name="arrow-right" size={16} color={theme.accent?.val} />}
                />
              </Pressable>
            ) : (
              <Pressable disabled={busy || !way.available} onPress={() => onPick(way)}>
                <Row
                  title={`${way.label}${way.recommended ? ' · recommended' : ''}`}
                  subtitle={way.available ? [way.reaches, way.description].filter(Boolean).join('. ') : (way.reason ?? 'Not available here')}
                  disabled={!way.available}
                  accessory={<Icon name={reach.holder(way.holder).icon} size={16} color={theme.muted?.val} />}
                />
              </Pressable>
            )}
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
