import type { ReactNode } from 'react';
import { Text, XStack, YStack } from 'tamagui';

import type { MeasurementSpec, Reading } from '@kraftverk/plugin-sdk';

import { Card } from './Card';
import { haptic } from './haptics';
import { formatMeasurement, primaryMeasurement, readingFor } from './measurement';

/**
 * One device, as a card.
 *
 * There is exactly one of these, and it is written against declarations rather
 * than against any particular device: a name, an icon, what it measures, and
 * what it last read. A station and a plug differ only in what they declared,
 * which is the point — the grid stops needing new code the moment a driver
 * starts providing something new.
 *
 * Offline is drawn, not hidden. A device you own that is unplugged is greyed
 * with its last state and a reason, because a card that vanishes is a card that
 * cannot tell you anything went wrong.
 */

export type DeviceCardDevice = {
  name: string;
  description?: string;
  online: boolean;
  detail?: string;
  measurements: readonly MeasurementSpec[];
  readings: readonly Reading[];
};

type Props = {
  device: DeviceCardDevice;
  /** Supplied by the app: this package has no icon set of its own. */
  icon?: ReactNode;
  /** Up to two more measurements under the headline. */
  secondary?: readonly MeasurementSpec[];
  onPress?: () => void;
};

export function DeviceCard({ device, icon, secondary, onPress }: Props) {
  const primary = primaryMeasurement(device.measurements);
  const primaryValue = primary
    ? formatMeasurement(primary, readingFor(device.readings, primary.key)?.value ?? null)
    : '—';

  const extras = (secondary ?? device.measurements.filter((m) => m !== primary).slice(0, 2)).map(
    (spec) => ({
      spec,
      text: formatMeasurement(spec, readingFor(device.readings, spec.key)?.value ?? null),
    })
  );

  return (
    <Card
      gap="$3"
      // Dimmed rather than dropped: the device is still yours, it is just quiet.
      opacity={device.online ? 1 : 0.55}
      cursor={onPress ? 'pointer' : undefined}
      pressStyle={onPress ? { opacity: 0.75 } : undefined}
      onPress={
        onPress
          ? () => {
              haptic();
              onPress();
            }
          : undefined
      }
    >
      <XStack alignItems="flex-start" justifyContent="space-between" gap="$3">
        <XStack alignItems="center" gap="$2.5" flex={1}>
          {icon}
          <YStack flex={1} gap={2}>
            <Text fontSize={16} fontWeight="700" color="$color" numberOfLines={1}>
              {device.name}
            </Text>
            {device.description ? (
              <Text fontSize={12} color="$muted" numberOfLines={1}>
                {device.description}
              </Text>
            ) : null}
          </YStack>
        </XStack>
        <YStack
          width={8}
          height={8}
          borderRadius={999}
          marginTop={6}
          backgroundColor={device.online ? '$success' : '$muted'}
        />
      </XStack>

      <XStack alignItems="flex-end" justifyContent="space-between" gap="$3">
        <YStack gap={2}>
          <Text fontSize={30} fontWeight="800" letterSpacing={-1} color="$color">
            {primaryValue}
          </Text>
          {primary ? (
            <Text fontSize={11} color="$muted" textTransform="uppercase" letterSpacing={0.6}>
              {primary.label}
            </Text>
          ) : null}
        </YStack>

        {extras.length > 0 ? (
          <YStack alignItems="flex-end" gap={3}>
            {extras.map(({ spec, text }) => (
              <XStack key={spec.key} alignItems="baseline" gap="$2">
                <Text fontSize={11} color="$muted">
                  {spec.label}
                </Text>
                <Text fontSize={13} fontWeight="600" color="$color">
                  {text}
                </Text>
              </XStack>
            ))}
          </YStack>
        ) : null}
      </XStack>

      {!device.online && device.detail ? (
        <Text fontSize={12} color="$muted" lineHeight={17}>
          {device.detail}
        </Text>
      ) : null}
    </Card>
  );
}
