import type { ComponentProps } from 'react';
import { Feather } from '@expo/vector-icons';
import { Text, useTheme, XStack, YStack } from 'tamagui';

export type FeatherName = ComponentProps<typeof Feather>['name'];

type Tone = 'color' | 'success' | 'warning' | 'danger' | 'muted';

type Props = {
  icon: FeatherName;
  label: string;
  value: string;
  tone?: Tone;
};

export function StatTile({ icon, label, value, tone = 'color' }: Props) {
  const theme = useTheme();

  return (
    <YStack
      flex={1}
      minWidth={104}
      gap="$2"
      padding="$3"
      borderRadius="$4"
      backgroundColor="$backgroundStrong"
      borderWidth={1}
      borderColor="$borderColor"
    >
      <XStack alignItems="center" gap="$2">
        <Feather name={icon} size={13} color={theme.muted?.val ?? '#888'} />
        <Text fontSize={11} color="$muted" fontWeight="600" letterSpacing={0.4}>
          {label}
        </Text>
      </XStack>
      <Text fontSize={22} fontWeight="700" color={`$${tone}`} numberOfLines={1}>
        {value}
      </Text>
    </YStack>
  );
}
