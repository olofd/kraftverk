import { useState } from 'react';
import { Button } from 'tamagui';

import { describeError, type SetupActionResult, type SetupStepView } from '@kraftverk/api-client';

import { Choices } from './ActionCard';
import { PRIMARY, StepFrame, type StepProps } from './StepFrame';

export function DiscoverStep({ flow, step, onNext, onBack }: StepProps & { step: Extract<SetupStepView, { kind: 'discover' }> }) {
  const [result, setResult] = useState<SetupActionResult | null>(null);
  const [busy, setBusy] = useState(false);

  const search = async () => {
    setBusy(true);
    try {
      setResult(await flow.discover(step.id));
    } catch (err) {
      setResult({ ok: false, detail: describeError(err) || 'The search failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepFrame title={step.title} description={step.description} onBack={onBack} next={{ label: 'Skip', onPress: onNext }}>
      <Button alignSelf="flex-start" size="$3" {...PRIMARY} disabled={busy} onPress={() => void search()}>
        {busy ? 'Searching…' : 'Search'}
      </Button>
      {result ? (
        <Choices
          result={result}
          picking={null}
          onPick={(choice) => {
            flow.update(step.target === 'device' ? { device: choice.config } : { connection: choice.config }).then(onNext, (err: unknown) => setResult({ ok: false, detail: describeError(err) || 'That could not be used' }));
          }}
        />
      ) : null}
    </StepFrame>
  );
}
