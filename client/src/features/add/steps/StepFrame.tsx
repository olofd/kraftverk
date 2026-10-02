import type { ReactNode } from 'react';
import { Button, Text, useTheme, XStack, YStack } from 'tamagui';

import type { SetupFlow } from '@kraftverk/api-client';
import { Icon } from '@kraftverk/ui';

import { ErrorText } from '../../../components/ErrorText';


export const PRIMARY = { backgroundColor: '$accent', color: '$background' } as const;

export type StepProps = {
  flow: SetupFlow;
  onNext: () => void;
  /** Back to the step before, or to choosing how to connect from the first. */
  onBack: () => void;
};

/**
 * What every step looks like: its title, what it is for, what it asks, and a
 * footer — Back always on the left, the way forward on the right.
 */
export function StepFrame({
  title,
  description,
  children,
  onBack,
  next,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onBack: () => void;
  next?: { label: string; onPress: () => void; disabled?: boolean };
}) {
  const theme = useTheme();
  return (
    <YStack gap="$3">
      <YStack gap="$1">
        <Text fontSize={20} fontWeight="800" color="$color" letterSpacing={-0.3}>
          {title}
        </Text>
        {description ? (
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {description}
          </Text>
        ) : null}
      </YStack>
      {children}
      <XStack justifyContent="space-between" alignItems="center" paddingTop="$1">
        <Button size="$3" chromeless icon={<Icon name="chevron-left" size={16} color={theme.muted?.val} />} onPress={onBack} color="$muted">
          Back
        </Button>
        {next ? (
          <Button size="$3" {...PRIMARY} disabled={next.disabled} opacity={next.disabled ? 0.5 : 1} onPress={next.onPress}>
            {next.label}
          </Button>
        ) : null}
      </XStack>
    </YStack>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <ErrorText paddingHorizontal="$1">
      {message}
    </ErrorText>
  ) : null;
}
