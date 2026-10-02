import { useCallback, useEffect, useState } from 'react';
import { Spinner, Text, XStack } from 'tamagui';

import { describeError, type CheckOutcome, type SetupFlow } from '@kraftverk/api-client';
import { Card } from '@kraftverk/ui';

import { StepFrame } from './StepFrame';

export function CheckStep({ flow, onChecked, onBack }: { flow: SetupFlow; onChecked: (outcome: CheckOutcome) => void; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      onChecked(await flow.check());
    } catch (err) {
      setError(describeError(err) || 'The check did not run');
    } finally {
      setBusy(false);
    }
  }, [flow, onChecked]);

  useEffect(() => {
    void check();
    // Once, when the step opens; "Try again" runs it after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <StepFrame title="Check that it answers" onBack={onBack} next={!busy && error ? { label: 'Try again', onPress: () => void check() } : undefined}>
      <Card gap="$3">
        <XStack gap="$3" alignItems="center">
          {busy ? <Spinner color="$accent" /> : null}
          <Text fontSize={14} color={error ? '$danger' : '$color'} flex={1} lineHeight={20}>
            {busy ? 'Reading it once, to be sure it answers…' : (error ?? 'Checked.')}
          </Text>
        </XStack>
      </Card>
    </StepFrame>
  );
}
