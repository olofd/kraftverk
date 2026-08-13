import type { ReactNode } from 'react';
import { Separator, Switch, Text, XStack, YStack } from 'tamagui';

import { haptic } from './haptics';

type RowProps = {
  title: string;
  subtitle?: string;
  /** Right-hand content: a Switch, a value label, a chevron… */
  accessory?: ReactNode;
  disabled?: boolean;
};

/** A single line in a settings/list card. */
export function Row({ title, subtitle, accessory, disabled }: RowProps) {
  return (
    <XStack
      alignItems="center"
      justifyContent="space-between"
      gap="$3"
      paddingHorizontal="$4"
      paddingVertical="$3"
      opacity={disabled ? 0.45 : 1}
    >
      <YStack flex={1} gap={2}>
        <Text fontSize={15} fontWeight="600" color="$color">
          {title}
        </Text>
        {subtitle ? (
          <Text fontSize={12} color="$muted" lineHeight={17}>
            {subtitle}
          </Text>
        ) : null}
      </YStack>
      {accessory}
    </XStack>
  );
}

export const RowSeparator = () => <Separator borderColor="$borderColor" marginHorizontal="$4" />;

type ToggleRowProps = Omit<RowProps, 'accessory'> & {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
};

export function ToggleRow({ checked, onCheckedChange, disabled, ...rest }: ToggleRowProps) {
  return (
    <Row
      {...rest}
      disabled={disabled}
      accessory={
        <Switch
          size="$3"
          checked={checked}
          disabled={disabled}
          onCheckedChange={(next) => {
            haptic();
            onCheckedChange(next);
          }}
          // The checked colour comes from the theme's `backgroundActive`;
          // Tamagui applies it after spreading props, so setting it here loses.
          backgroundColor="$backgroundPress"
        >
          <Switch.Thumb transition="fast" backgroundColor="$white" />
        </Switch>
      }
    />
  );
}
