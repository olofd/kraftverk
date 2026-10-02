import { useState } from 'react';
import { Text, useTheme, XStack } from 'tamagui';

import type { ConfigValues, SetupChoice, SetupStepView } from '@kraftverk/api-client';
import { Card, Icon, isComplete, SchemaForm } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { useAttempt } from '../../../components/useAttempt';
import { ActionCard } from './ActionCard';
import { ErrorLine, StepFrame, type StepProps } from './StepFrame';

export function FormStep({ flow, step, onNext, onBack, onNamed }: StepProps & { step: Extract<SetupStepView, { kind: 'form' }>; onNamed: (name: string) => void }) {
  const current = () => (step.target === 'device' ? flow.device : flow.connection) as ConfigValues;
  const [values, setValues] = useState<ConfigValues>(current);
  const { busy, setBusy, error, attempt } = useAttempt();
  const filled = isComplete(step.schema, current(), flow.secrets);
  // With helpers, typing it all in is the fallback, one tap away — unless it is already filled.
  const [typing, setTyping] = useState(step.actions.length === 0 || filled);
  const theme = useTheme();

  const apply = (patch: ConfigValues) => flow.update(step.target === 'device' ? { device: patch } : { connection: patch });

  const run = async (work: () => Promise<void>) => {
    await attempt(async () => {
      await work();
    }, 'That did not work');
  };

  const canContinue = !busy && isComplete(step.schema, values, flow.secrets);
  const proceed = () =>
    void run(async () => {
      await apply(values);
      onNext();
    });

  /** A helper's answer: its values, and — when it knows — where the device is and what it is called. */
  const done = (choice: SetupChoice | null) =>
    void run(async () => {
      if (choice) {
        await apply(choice.config);
        // A method with an address of its own has nothing to choose.
        if (choice.address && choice.address !== flow.address) {
          // Heard on the network: chosen as the list would; otherwise as if typed.
          await flow.choose({ address: choice.address }).catch(() => flow.choose({ manual: choice.address! }));
        }
        if (choice.name) onNamed(choice.name);
      }
      setValues(current());
      onNext();
    });

  return (
    <StepFrame
      title={step.title}
      description={step.description ?? step.schema.help}
      onBack={onBack}
      next={typing ? { label: 'Continue', disabled: !canContinue, onPress: proceed } : undefined}
    >
      {step.actions.map((action, index) => (
        <ActionCard key={action.id} flow={flow} stepId={step.id} action={action} primary={index === 0} busy={busy} setBusy={setBusy} onDone={done} />
      ))}

      {step.actions.length && !typing ? (
        <Pressable onPress={() => setTyping(true)}>
          <XStack alignItems="center" gap="$2" paddingHorizontal="$2" paddingVertical="$2">
            <Icon name="edit-3" size={14} color={theme.muted?.val} />
            <Text fontSize={13} color="$muted">
              I have them already — type them in
            </Text>
          </XStack>
        </Pressable>
      ) : null}

      {typing ? (
        <Card inset>
          <SchemaForm schema={step.schema} values={values} secretsSet={flow.secrets} disabled={busy} onChange={(name, value) => setValues((before) => ({ ...before, [name]: value }))} onSubmit={() => (canContinue ? proceed() : undefined)} />
        </Card>
      ) : null}
      <ErrorLine message={error} />
    </StepFrame>
  );
}
