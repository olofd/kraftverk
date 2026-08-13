import { useCallback, useEffect, useMemo, useState } from 'react';
import Svg, { Line, Path } from 'react-native-svg';
import { Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, fetchDeviceHistory } from '@kraftverk/api-client';
import type { MeasurementSpec, SeriesPoint } from '@kraftverk/api-client';
import {
  chartPath,
  chartScale,
  chartSegments,
  chartY,
  formatMeasurement,
  haptic,
} from '@kraftverk/ui';

/**
 * One chart, for every measurement of every device.
 *
 * This is what the device model was for. It is written against a
 * `MeasurementSpec` and a list of points, so a plug added next year is charted
 * by code that predates it — the kind decides the axis, the unit decides the
 * labels, and nothing here has an opinion about what is being measured.
 *
 * The arithmetic lives in `@kraftverk/ui`, not in this file. What is left here
 * is pixels: fetching, laying out, and drawing what the maths decided.
 */

const RANGES = [
  { hours: 6, label: '6h' },
  { hours: 24, label: '24h' },
  { hours: 24 * 7, label: '7d' },
] as const;

const HEIGHT = 140;

export function MeasurementChart({
  deviceId,
  measurement,
}: {
  deviceId: string;
  measurement: MeasurementSpec;
}) {
  const [hours, setHours] = useState<number>(24);
  const [points, setPoints] = useState<SeriesPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const theme = useTheme();

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const history = await fetchDeviceHistory(deviceId, measurement.key, { hours }, signal);
        setPoints(history.points);
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (!message) return; // aborted
        setPoints([]);
        setError(message);
      }
    },
    [deviceId, hours, measurement.key]
  );

  useEffect(() => {
    const controller = new AbortController();
    setPoints(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const scale = useMemo(() => chartScale(points ?? [], measurement), [measurement, points]);
  const segments = useMemo(() => chartSegments(points ?? []), [points]);

  return (
    <YStack gap="$2.5">
      <XStack justifyContent="space-between" alignItems="center">
        <Text fontSize={12} color="$muted">
          {measurement.label}
        </Text>
        <XStack gap="$1.5">
          {RANGES.map((range) => (
            <Text
              key={range.hours}
              fontSize={11}
              fontWeight="700"
              paddingHorizontal="$2"
              paddingVertical="$1"
              borderRadius="$2"
              color={range.hours === hours ? '$color' : '$muted'}
              backgroundColor={range.hours === hours ? '$backgroundPress' : 'transparent'}
              pressStyle={{ opacity: 0.6 }}
              onPress={() => {
                haptic();
                setHours(range.hours);
              }}
            >
              {range.label}
            </Text>
          ))}
        </XStack>
      </XStack>

      <YStack
        height={HEIGHT}
        justifyContent="center"
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {points === null ? (
          <YStack alignItems="center">
            <Spinner color="$accent" />
          </YStack>
        ) : segments.length === 0 ? (
          <Text fontSize={12} color="$muted" textAlign="center" lineHeight={18}>
            {error ??
              'Nothing recorded for this window yet. The server samples once a minute, so a new device takes a few minutes to have anything to show.'}
          </Text>
        ) : width > 0 ? (
          <Svg width={width} height={HEIGHT}>
            {/* A baseline only where zero is inside the range and means something. */}
            {scale.min <= 0 && scale.max >= 0 ? (
              <Line
                x1={0}
                x2={width}
                y1={chartY(0, scale, HEIGHT)}
                y2={chartY(0, scale, HEIGHT)}
                stroke={theme.borderColor?.val}
                strokeWidth={1}
              />
            ) : null}

            {segments.map((segment) => (
              <Path
                key={segment[0]}
                d={chartPath(points, segment, { width, height: HEIGHT }, scale)}
                fill="none"
                stroke={theme.accent?.val}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </Svg>
        ) : null}
      </YStack>

      {segments.length > 0 ? (
        <XStack justifyContent="space-between">
          <Text fontSize={11} color="$muted">
            low {formatMeasurement(measurement, scale.trough)}
          </Text>
          <Text fontSize={11} color="$muted">
            {segments.length > 1 ? `${segments.length} runs · gaps not drawn` : 'continuous'}
          </Text>
          <Text fontSize={11} color="$muted">
            peak {formatMeasurement(measurement, scale.peak)}
          </Text>
        </XStack>
      ) : null}
    </YStack>
  );
}
