import { useCallback, useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import { describeError } from '@kraftverk/api-client';

import { useFamily } from '../../state/FamilyProvider';

/** How many lines a diagnostic is asked for, and how much of its answer is shown: a page, not a log file. */
const DIAGNOSTIC_LINES = 50;
const SHOWN_AT_MOST = 20_000;

/** A transport's read-only diagnostics, one at a time, as the transport reports them. */
export function Diagnostics({ transport, names }: { transport: string; names: string[] }) {
  const { api } = useFamily();
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
        const data = await api.transports.diagnostic(transport, name, { limit: String(DIAGNOSTIC_LINES) });
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
          {shown.body.length > SHOWN_AT_MOST ? `${shown.body.slice(0, SHOWN_AT_MOST)}\n…` : shown.body}
        </Text>
      ) : null}
    </YStack>
  );
}

