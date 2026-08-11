import { Text, XStack, YStack } from 'tamagui';

import type { StationStatus } from '../lib/types';
import { STATE_TINT } from '../lib/format';

type Props = {
  level: number;
  /** Charge stops here, drawn as a notch on the track. */
  chargeLimit: number;
  state: StationStatus['state'];
};

/**
 * A horizontal battery gauge. Deliberately built from plain views rather than
 * SVG so it renders identically on iOS and web with no extra native module.
 */
export function ChargeMeter({ level, chargeLimit, state }: Props) {
  const tint = STATE_TINT[state];
  const clamped = Math.max(0, Math.min(100, level));

  return (
    <YStack gap="$2">
      <YStack
        height={14}
        borderRadius={999}
        backgroundColor="$backgroundPress"
        overflow="hidden"
        position="relative"
      >
        <YStack
          height="100%"
          width={`${clamped}%`}
          borderRadius={999}
          backgroundColor={tint}
          transition="medium"
        />

        {chargeLimit < 100 ? (
          <YStack
            position="absolute"
            left={`${chargeLimit}%`}
            top={0}
            bottom={0}
            width={2}
            backgroundColor="$color"
            opacity={0.35}
          />
        ) : null}
      </YStack>

      <XStack justifyContent="space-between">
        <Text fontSize={11} color="$muted">
          0%
        </Text>
        {chargeLimit < 100 ? (
          <Text fontSize={11} color="$muted">
            limit {chargeLimit}%
          </Text>
        ) : null}
        <Text fontSize={11} color="$muted">
          100%
        </Text>
      </XStack>
    </YStack>
  );
}
