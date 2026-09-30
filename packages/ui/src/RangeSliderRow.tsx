import { useEffect, useState } from 'react';
import { Slider, Text, XStack, YStack } from 'tamagui';

import { PendingMark } from './PendingMark';
import { SliderMarker, type Marker } from './SliderMarker';

type Range = readonly [number, number];

type Props = {
  title: string;
  subtitle?: string;
  /** The low and the high end, as the device has them. */
  value: Range;
  min: number;
  max: number;
  step?: number;
  /** The closest the two ends may come. */
  gap?: number;
  format?: (value: number) => string;
  /** What each end means: "Cut below", "Cut above". */
  labels: readonly [string, string];
  marker?: Marker | null;
  /** What is wrong with the range as it stands, for the one being dragged. */
  warn?: (value: Range) => string | null;
  disabled?: boolean;
  pending?: boolean;
  /** On release, with only the ends that moved. */
  onCommit: (low: number | null, high: number | null) => void;
};

/**
 * A window between two limits on one track — the voltages a plug accepts —
 * with what is measured now marked inside it, so "is my supply inside?" is
 * answered by looking.
 */
export function RangeSliderRow({
  title,
  subtitle,
  value,
  min,
  max,
  step = 1,
  gap = step,
  format = (v) => String(v),
  labels,
  marker,
  warn,
  disabled,
  pending,
  onCommit,
}: Props) {
  const [local, setLocal] = useState<Range>(value);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) setLocal(value);
    // The pair, by its ends: a new array with the same ends is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value[0], value[1], dragging]);

  const warning = warn?.(local) ?? null;
  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  return (
    <YStack gap="$3" paddingHorizontal="$4" paddingVertical="$3" opacity={disabled ? 0.45 : 1}>
      <XStack alignItems="center" justifyContent="space-between" gap="$3">
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
        {pending ? <PendingMark /> : null}
      </XStack>

      <XStack justifyContent="space-between">
        {[0, 1].map((end) => (
          <YStack key={end} alignItems={end ? 'flex-end' : 'flex-start'} gap={1}>
            <Text fontSize={11} color="$muted">
              {labels[end]}
            </Text>
            <Text fontSize={17} fontWeight="700" color={warning ? '$warning' : '$accent'} fontVariant={['tabular-nums']}>
              {format(local[end]!)}
            </Text>
          </YStack>
        ))}
      </XStack>

      <YStack position="relative" paddingTop={marker ? 28 : 0}>
        {marker ? <SliderMarker marker={marker} min={min} max={max} /> : null}
        <Slider
          size="$2"
          min={min}
          max={max}
          step={step}
          disabled={disabled || pending}
          aria-busy={pending || undefined}
          aria-label={title}
          value={[clamp(local[0]), clamp(local[1])]}
          onValueChange={(next) => {
            const [low, high] = next;
            if (typeof low !== 'number' || typeof high !== 'number') return;
            setDragging(true);
            // The ends never cross, nor come closer than the gap.
            setLocal((was) => (low !== was[0] ? [Math.min(low, high - gap), high] : [low, Math.max(high, low + gap)]));
          }}
          onSlideEnd={() => {
            setDragging(false);
            const low = local[0] !== value[0] ? local[0] : null;
            const high = local[1] !== value[1] ? local[1] : null;
            if (low !== null || high !== null) onCommit(low, high);
          }}
        >
          <Slider.Track backgroundColor="$backgroundPress">
            <Slider.TrackActive backgroundColor={warning ? '$warning' : '$accent'} />
          </Slider.Track>
          <Slider.Thumb index={0} circular size="$1" backgroundColor="$white" borderWidth={3} borderColor={warning ? '$warning' : '$accent'} aria-label={labels[0]} />
          <Slider.Thumb index={1} circular size="$1" backgroundColor="$white" borderWidth={3} borderColor={warning ? '$warning' : '$accent'} aria-label={labels[1]} />
        </Slider>
      </YStack>

      {warning ? (
        <Text fontSize={12} color="$warning" lineHeight={17}>
          {warning}
        </Text>
      ) : null}
    </YStack>
  );
}
