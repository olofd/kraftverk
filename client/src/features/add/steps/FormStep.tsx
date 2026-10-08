import { useState } from 'react';
import { Text, useTheme, XStack, YStack } from 'tamagui';

import { isSecretField, type ConfigValues, type SetupActionResult, type SetupChoice, type SetupStepView } from '@kraftverk/device-sdk';
import { Card, Icon, isComplete, SchemaForm } from '@kraftverk/ui';

import { Pressable } from '../../../components/Pressable';
import { useAttempt } from '../../../components/useAttempt';
import { useNow } from '../../automations/looks';
import { ActionCard, Asked, Choices, countdown } from './ActionCard';
import { ErrorLine, StepFrame, type StepProps } from './StepFrame';

export function FormStep({ flow, step, onNext, onBack, onNamed }: StepProps & { step: Extract<SetupStepView, { kind: 'form' }>; onNamed: (name: string) => void }) {
  const current = () => (step.target === 'device' ? flow.device : flow.connection) as ConfigValues;
  const [values, setValues] = useState<ConfigValues>(current);
  const { busy, setBusy, error, attempt } = useAttempt();
  const filled = isComplete(step.schema, current(), flow.secrets);
  // A sign-in that is the step's own button: the fields above it are what it signs in with.
  const primary = step.actions.find((action) => action.primary) ?? null;
  const helpers = step.actions.filter((action) => action !== primary);
  // With helpers, typing it all in is the fallback, one tap away — unless it is already filled, or the step signs in with what is typed.
  const [typing, setTyping] = useState(helpers.length === 0 || filled || primary !== null);
  // What the sign-in answered last: a question (a code), a refusal, candidates.
  const [answered, setAnswered] = useState<SetupActionResult | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  // Not before then: a vendor refusing sign-ins for a while — tried sooner, longer.
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const now = useNow(retryAt !== null && retryAt > Date.now());
  const waiting = retryAt !== null && retryAt > now ? retryAt - now : 0;
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

  /** What the sign-in said: asked again, refused, candidates — or done, and on to the next step. */
  const took = (result: SetupActionResult) => {
    setRefused(null);
    setRetryAt(result.retryAt ? Date.parse(result.retryAt) : null);
    if (result.ask || result.choices?.length) return setAnswered(result);
    setAnswered(null);
    if (!result.ok) return setRefused(result.detail);
    done(null);
  };

  /** Signs in: what is typed kept first — so a password is never asked twice — then the sign-in, afresh. */
  const signIn = () =>
    void run(async () => {
      await apply(values);
      took(await flow.action(step.id, primary!.id, {}));
    });
  const answer = (answers: ConfigValues) => void run(async () => took(await flow.action(step.id, primary!.id, answers)));
  const restart = () => {
    setAnswered(null);
    setRefused(null);
  };

  // Who is signing in, while a code is asked: what was typed that is not secret.
  const signingInAs = Object.entries(step.schema.fields)
    .filter(([name, field]) => !isSecretField(field) && typeof values[name] === 'string' && values[name])
    .map(([name]) => String(values[name]))
    .join(' · ');

  const next = primary
    ? answered
      ? undefined
      : { label: busy ? 'Signing in…' : waiting ? `Try again in ${countdown(waiting)}` : primary.label, disabled: !canContinue || waiting > 0, onPress: signIn }
    : typing
      ? { label: 'Continue', disabled: !canContinue, onPress: proceed }
      : undefined;

  return (
    <StepFrame title={step.title} description={step.description ?? step.schema.help} onBack={onBack} next={next}>
      {primary && answered ? (
        <YStack gap="$3">
          {signingInAs ? (
            <XStack alignItems="center" justifyContent="space-between" paddingHorizontal="$2">
              <Text fontSize={13} color="$muted" flex={1} numberOfLines={1}>
                {signingInAs}
              </Text>
              <Pressable onPress={restart} disabled={busy}>
                <Text fontSize={13} color="$accent" paddingVertical="$1">
                  Change
                </Text>
              </Pressable>
            </XStack>
          ) : null}
          <Card gap="$3">
            {answered.ask ? (
              <Asked result={answered} busy={busy} onAnswer={answer} onRestart={restart} />
            ) : (
              <Choices result={answered} picking={null} onPick={(choice) => done(choice)} />
            )}
          </Card>
        </YStack>
      ) : null}

      {helpers.map((action, index) => (
        <ActionCard key={action.id} flow={flow} stepId={step.id} action={action} primary={!primary && index === 0} busy={busy} setBusy={setBusy} onDone={done} />
      ))}

      {helpers.length && !typing ? (
        <Pressable onPress={() => setTyping(true)}>
          <XStack alignItems="center" gap="$2" paddingHorizontal="$2" paddingVertical="$2">
            <Icon name="edit-3" size={14} color={theme.muted?.val} />
            <Text fontSize={13} color="$muted">
              I have them already — type them in
            </Text>
          </XStack>
        </Pressable>
      ) : null}

      {typing && !(primary && answered) ? (
        <Card inset>
          <SchemaForm
            // Its help said once: above, as the step's own words, when it has none of its own.
            schema={step.description ? step.schema : { ...step.schema, help: undefined }}
            values={values}
            secretsSet={flow.secrets}
            disabled={busy}
            onChange={(name, value) => setValues((before) => ({ ...before, [name]: value }))}
            // Enter is the button: held while the vendor says "not now", as the button is.
            onSubmit={() => (canContinue && !waiting ? (primary ? signIn() : proceed()) : undefined)}
          />
        </Card>
      ) : null}
      <ErrorLine message={refused ?? error} />
    </StepFrame>
  );
}
