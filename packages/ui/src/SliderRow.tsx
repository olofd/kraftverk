import { Slider, Text, XStack, YStack } from 'tamagui';

import { PendingMark } from './PendingMark';
import { SliderMarker, type Marker } from './SliderMarker';
import { useSlide } from './useSlide';

type Props = {
  title: string;
  subtitle?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  format?: (value: number) => string;
  /** What the ends of the track mean, when the numbers alone do not say: "Dim", "Bright". */
  ends?: readonly [string, string];
  /** Where the thing measured is now, drawn on the track: the mains voltage against a voltage limit. */
  marker?: Marker | null;
  /**
   * What is wrong with the value as it stands, said beside it: "Above the mains
   * voltage: it would cut at once". Worked out by the caller for the value being
   * dragged, so it is said before anything is written.
   */
  warn?: (value: number) => string | null;
  disabled?: boolean;
  /**
   * The device has not confirmed `value` yet: the thumb stays where it was
   * released, and cannot be moved again until it does.
   */
  pending?: boolean;
  /** Fired once, on release or when the keys stop, so we don't PATCH on every pixel of the drag. */
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
  ends,
  marker,
  warn,
  disabled,
  pending,
  onCommit,
}: Props) {
  const slide = useSlide(value, String, onCommit);
  const local = slide.local;

  const warning = warn?.(local) ?? null;

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
        <YStack alignItems="flex-end" gap={2}>
          <Text fontSize={15} fontWeight="700" color={warning ? '$warning' : '$accent'} fontVariant={['tabular-nums']}>
            {format(local)}
          </Text>
          {pending ? <PendingMark /> : null}
        </YStack>
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
          value={[Math.min(max, Math.max(min, local))]}
          onValueChange={([next]) => {
            if (typeof next === 'number') slide.change(() => next);
          }}
          onSlideStart={slide.onSlideStart}
          onSlideEnd={slide.onSlideEnd}
        >
          <Slider.Track backgroundColor="$backgroundPress">
            <Slider.TrackActive backgroundColor={warning ? '$warning' : '$accent'} />
          </Slider.Track>
          {/* The thumb is what a keyboard and a screen reader reach: it carries the name. */}
          <Slider.Thumb index={0} circular size="$1" backgroundColor="$white" borderWidth={3} borderColor={warning ? '$warning' : '$accent'} aria-label={title} />
        </Slider>
      </YStack>

      {ends ? (
        <XStack justifyContent="space-between">
          <Text fontSize={11} color="$muted">
            {ends[0]}
          </Text>
          <Text fontSize={11} color="$muted">
            {ends[1]}
          </Text>
        </XStack>
      ) : null}

      {warning ? (
        <Text fontSize={12} color="$warning" lineHeight={17}>
          {warning}
        </Text>
      ) : null}
    </YStack>
  );
}
