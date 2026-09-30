import type { ReactNode } from 'react';
import { Text, XStack, YStack } from 'tamagui';

type Props = {
  label: string;
  /** Already formatted, without the unit: "234.4". A dash when the device has not said. */
  value: string;
  unit?: string;
  /** One short line under the figure: "safe between 140 and 258 V". */
  note?: string | null;
  /**
   * Where the value sits between two limits, 0 to 1, drawn as a bar under it —
   * the voltage inside its cut-off window. Null for no bar.
   */
  position?: number | null;
  tone?: 'normal' | 'warning' | 'danger';
  icon?: ReactNode;
};

/**
 * One measured figure, large, on a tile of its own: what a glance at a device
 * is for. Tiles sit two or three to a row.
 */
export function StatTile({ label, value, unit, note, position, tone = 'normal', icon }: Props) {
  const color = tone === 'danger' ? '$danger' : tone === 'warning' ? '$warning' : '$color';
  return (
    <YStack flex={1} minWidth={140} backgroundColor="$card" borderRadius="$4" padding="$3" gap="$1" borderWidth={1} borderColor="$borderColor">
      <XStack alignItems="center" gap={6}>
        {icon}
        <Text fontSize={12} color="$muted" fontWeight="600">
          {label}
        </Text>
      </XStack>
      <XStack alignItems="baseline" gap={4}>
        <Text fontSize={22} fontWeight="700" color={color} fontVariant={['tabular-nums']}>
          {value}
        </Text>
        {unit ? (
          <Text fontSize={13} color="$muted" fontWeight="600">
            {unit}
          </Text>
        ) : null}
      </XStack>
      {position !== undefined && position !== null ? (
        <YStack height={4} borderRadius={2} backgroundColor="$backgroundPress" overflow="hidden" marginTop={2}>
          <YStack height={4} width={`${Math.round(Math.min(1, Math.max(0, position)) * 100)}%`} backgroundColor={tone === 'normal' ? '$accent' : color} borderRadius={2} />
        </YStack>
      ) : null}
      {note ? (
        <Text fontSize={11} color="$muted" lineHeight={15}>
          {note}
        </Text>
      ) : null}
    </YStack>
  );
}
