import { Text } from 'tamagui';

import type { CheckOutcome, SetupStepView } from '@kraftverk/api-client';
import { Card } from '@kraftverk/ui';

import { CheckStep } from './CheckStep';
import { ChooseStep } from './ChooseStep';
import { DiscoverStep } from './DiscoverStep';
import { FormStep } from './FormStep';
import { StepFrame, type StepProps } from './StepFrame';

export function StepView({
  flow,
  step,
  onNext,
  onBack,
  onChecked,
  onNamed,
  presetAddress,
}: StepProps & {
  step: SetupStepView;
  onChecked: (outcome: CheckOutcome) => void;
  /** A helper learnt what the device is called: offered as its name when it is saved. */
  onNamed: (name: string) => void;
  /** An address chosen before the flow started: "found near you". */
  presetAddress?: string;
}) {
  switch (step.kind) {
    case 'instructions':
      return (
        <StepFrame title={step.title} onBack={onBack} next={{ label: 'It is ready', onPress: onNext }}>
          <Card gap="$3">
            <Text fontSize={14} color="$color" lineHeight={21}>
              {step.body}
            </Text>
          </Card>
        </StepFrame>
      );
    case 'choose':
      return <ChooseStep flow={flow} step={step} onNext={onNext} onBack={onBack} presetAddress={presetAddress} />;
    case 'form':
      return <FormStep flow={flow} step={step} onNext={onNext} onBack={onBack} onNamed={onNamed} />;
    case 'discover':
      return <DiscoverStep flow={flow} step={step} onNext={onNext} onBack={onBack} />;
    case 'check':
      return <CheckStep flow={flow} onChecked={onChecked} onBack={onBack} />;
  }
}
