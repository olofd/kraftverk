import { useCallback, useEffect } from 'react';
import { Spinner, Text, XStack } from 'tamagui';

import type { CheckOutcome, SetupFlow } from '@kraftverk/api-client';
import { Card } from '@kraftverk/ui';

import { useAttempt } from '../../../components/useAttempt';
import { StepFrame } from './StepFrame';

export function CheckStep({ flow, onChecked, onBack }: { flow: SetupFlow; onChecked: (outcome: CheckOutcome) => void; onBack: () => void }) {
  const { busy, error, attempt } = useAttempt();

  const check = useCallback(async () => {
    await attempt(async () => {
      onChecked(await flow.check());
    }, 'The check did not run');
  }, [flow, onChecked]);

  useEffect(() => {
    void check();
    // Once, when the step opens; "Try again" runs it after that.
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
