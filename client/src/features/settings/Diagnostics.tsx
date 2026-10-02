import { useCallback, useState } from 'react';
import { Button, Text, XStack, YStack } from 'tamagui';

import { describeError } from '@kraftverk/api-client';

import { useHome } from '../../state/HomeProvider';

/** A transport's read-only diagnostics, one at a time, as the transport reports them. */
export function Diagnostics({ transport, names }: { transport: string; names: string[] }) {
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

export const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
