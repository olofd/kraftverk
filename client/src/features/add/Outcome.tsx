import { router } from 'expo-router';
import { Button, Text, XStack } from 'tamagui';

import { type CheckOutcome, type DeviceView, mayContinue, PATHS } from '@kraftverk/api-client';
import { Card } from '@kraftverk/ui';

export function Outcome({
  outcome,
  attachTo,
  earlier,
  onBack,
  onRetry,
  onContinue,
  onOtherType,
}: {
  outcome: CheckOutcome;
  attachTo: DeviceView | null;
  /** There are steps before the check to go back to. */
  earlier: boolean;
  /** To the step before the check, to change what was entered — or, with none, to how it is reached. */
  onBack: () => void;
  onRetry: () => void;
  onContinue: () => void;
  onOtherType: (typeId: string) => void;
}) {
  const [tone, heading] =
    outcome.outcome === 'new'
      ? (['$success', attachTo ? `It answered. Is it ${attachTo.name}?` : 'It answered'] as const)
      : outcome.outcome === 'yours'
        ? (['$accent', attachTo && outcome.device.id === attachTo.id ? `This is ${attachTo.name}` : `You already have this: ${outcome.device.name}`] as const)
        : outcome.outcome === 'removed'
          ? (['$accent', 'You had this before'] as const)
          : outcome.outcome === 'other-model'
            ? (['$warning', 'That is a different product'] as const)
            : (['$warning', 'It did not answer'] as const);

  const canContinue = mayContinue(outcome, attachTo?.id ?? null);

  return (
    <Card gap="$3" borderColor={tone}>
      <Text fontSize={15} fontWeight="700" color={tone}>
        {heading}
      </Text>
      <Text fontSize={13} color="$muted" lineHeight={19}>
        {outcome.summary}
        {outcome.outcome === 'no-answer' && outcome.saveAnyway ? ` ${outcome.saveAnyway}` : ''}
        {outcome.outcome === 'new' && attachTo && outcome.identity === null
          ? ` It cannot say which device it is from here, so it is taken on your word that it is ${attachTo.name}.`
          : ''}
      </Text>
      <XStack gap="$2" flexWrap="wrap">
        {canContinue ? (
          <Button size="$3" backgroundColor="$accent" color="$background" onPress={onContinue}>
            {outcome.outcome === 'no-answer' ? 'Save it anyway' : 'Continue'}
          </Button>
        ) : null}
        {outcome.outcome === 'yours' && (!attachTo || outcome.device.id !== attachTo.id) ? (
          <Button size="$3" onPress={() => router.replace(PATHS.devices.one(outcome.device.id))}>
            Open {outcome.device.name}
          </Button>
        ) : null}
        {outcome.outcome === 'other-model' && outcome.type ? (
          <Button size="$3" onPress={() => onOtherType(outcome.type!.id)}>
            Set it up as {outcome.type.name}
          </Button>
        ) : null}
        <Button size="$3" onPress={onRetry}>
          Try again
        </Button>
        <Button size="$3" chromeless color="$muted" onPress={onBack}>
          {earlier ? 'Change what I entered' : 'Reach it another way'}
        </Button>
      </XStack>
    </Card>
  );
}
