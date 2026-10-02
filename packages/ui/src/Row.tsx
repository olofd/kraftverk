import type { ReactNode } from 'react';
import { Separator, Text, XStack, YStack } from 'tamagui';

import { Toggle } from './Toggle';

type RowProps = {
  title: string;
  subtitle?: string;
  /** Right-hand content: a Switch, a value label, a chevron… */
  accessory?: ReactNode;
  /** Left-hand content: the device's picture, an icon. */
  leading?: ReactNode;
  disabled?: boolean;
};

/** A single line in a settings/list card. */
export function Row({ title, subtitle, accessory, leading, disabled }: RowProps) {
  return (
    <XStack
      alignItems="center"
      justifyContent="space-between"
      gap="$3"
      paddingHorizontal="$4"
      paddingVertical="$3"
      opacity={disabled ? 0.45 : 1}
    >
      {leading}
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
  /** The device has not confirmed `checked` yet. See `Toggle`. */
  pending?: boolean;
};

/** The keys a list of toggle rows has chosen, with one turned on or off. */
export const toggled = (chosen: ReadonlySet<string>, key: string, on: boolean): ReadonlySet<string> => {
  const next = new Set(chosen);
  if (on) next.add(key);
  else next.delete(key);
  return next;
};

export function ToggleRow({ checked, onCheckedChange, disabled, pending, subtitle, ...rest }: ToggleRowProps) {
  return (
    <Row
      {...rest}
      // Said in words as well as by the spinner: the switch shows where it is
      // going, and this says it is not there yet.
      subtitle={pending ? `${checked ? 'Switching on' : 'Switching off'} — waiting for the device` : subtitle}
      disabled={disabled}
      accessory={
        <Toggle checked={checked} label={rest.title} disabled={disabled} pending={pending} onCheckedChange={onCheckedChange} />
      }
    />
  );
}
