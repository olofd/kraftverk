import { Spinner, Text } from 'tamagui';

import { Card } from '@kraftverk/ui';

/** What a screen shows until what it reads has come: a spinner — or, when reading it failed, why, in a card of its own. */
export function Loading({ error }: { error: string | null }) {
  if (!error) return <Spinner color="$accent" />;
  return (
    <Card borderColor="$danger">
      <Text fontSize={14} color="$danger" role="alert">
        {error}
      </Text>
    </Card>
  );
}
