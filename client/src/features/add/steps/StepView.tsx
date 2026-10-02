import { Text } from 'tamagui';

import type { SetupStepView } from '@kraftverk/device-sdk';
import type { CheckOutcome } from '@kraftverk/api-client';
import { Card } from '@kraftverk/ui';

import { CheckStep } from './CheckStep';
import { ChooseStep } from './ChooseStep';
import { DiscoverStep } from './DiscoverStep';
import { FormStep } from './FormStep';
import { StepFrame, type StepProps } from './StepFrame';

/*
  One setup step, drawn from its view (docs/DATA-MODEL.md §1). Nothing here
  knows a product: a station's "point it at this server", a plug's "sign in
  with the maker's app", the check — all arrive as data from the layers that
  supply them.

  Every step can go back. What was entered stays in the draft, so going back
  and forward again changes only what is changed.
*/

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
