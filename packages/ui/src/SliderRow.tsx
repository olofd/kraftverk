import { useEffect, useState } from 'react';
import { Slider, Text, XStack, YStack } from 'tamagui';

type Props = {
  title: string;
  subtitle?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  disabled?: boolean;
  /** Fired once on release, so we don't PATCH on every pixel of the drag. */
  onCommit: (value: number) => void;
};

export function SliderRow({
  title,
  subtitle,
  value,
  min,
  max,
  step = 1,
  format = (v) => String(v),
  disabled,
  onCommit,
}: Props) {
  const [local, setLocal] = useState(value);
  const [dragging, setDragging] = useState(false);

  // Follow the server while idle, but never yank the thumb mid-drag.
  useEffect(() => {
    if (!dragging) setLocal(value);
  }, [value, dragging]);

  return (
    <YStack gap="$3" paddingHorizontal="$4" paddingVertical="$3" opacity={disabled ? 0.45 : 1}>
      <XStack alignItems="flex-start" justifyContent="space-between" gap="$3">
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
        <Text fontSize={15} fontWeight="700" color="$accent" fontVariant={['tabular-nums']}>
          {format(local)}
        </Text>
      </XStack>

      <Slider
        size="$2"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={[local]}
        onValueChange={([next]) => {
          setDragging(true);
          if (typeof next === 'number') setLocal(next);
        }}
        onSlideEnd={() => {
          setDragging(false);
          if (local !== value) onCommit(local);
        }}
      >
        <Slider.Track backgroundColor="$backgroundPress">
          <Slider.TrackActive backgroundColor="$accent" />
        </Slider.Track>
        <Slider.Thumb index={0} circular size="$1" borderColor="$borderColor" />
      </Slider>
    </YStack>
  );
}
