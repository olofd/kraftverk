import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { Text, useTheme, XStack, YStack } from 'tamagui';

import type { RunLogReach } from '@kraftverk/api-client';
import { chartScale, chartY } from '@kraftverk/ui';

import { atOf, heldPath, said, spansOf, valueAt, xOf, type Mark, type Series, type Window } from '@kraftverk/automation-engine';

/*
  One value of a run's log, drawn across the run (docs/SEQUENCES.md): a
  number as a line held from one reading to the next, on/off and options as
  bands; the time its device could not be reached shaded; every step that
  changed something a line across, numbered as the steps are; and the cursor
  — set by a tap or a drag on any chart — at the same instant on all of them.
*/

const NUMBER_HEIGHT = 56;
const BAND_HEIGHT = 22;

type Props = {
  series: Series;
  window: Window;
  marks: readonly Mark[];
  /** When its device could not be reached, while the run ran. */
  away: readonly { from: number; to: number }[];
  cursor: number | null;
  onCursor: (at: number) => void;
};

/** The spans a device could not be reached for: from each "not" to the next "could", or to the run's end. */
export function awayOf(reach: readonly RunLogReach[], device: string, window: Window): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = [];
  let since: number | null = null;
  for (const each of reach.filter((entry) => entry.device === device)) {
    const at = Math.max(window.from, Date.parse(each.at));
    if (!each.reachable && since === null) since = at;
    if (each.reachable && since !== null) {
      spans.push({ from: since, to: at });
      since = null;
    }
  }
  if (since !== null) spans.push({ from: since, to: window.to });
  return spans;
}

export function RunChart({ series, window, marks, away, cursor, onCursor }: Props) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const { key, points } = series;
  const height = key.kind === 'number' ? NUMBER_HEIGHT : BAND_HEIGHT;
  const now = cursor === null ? points.at(-1) : valueAt(series, cursor);
  const color = (name: string) => theme[name]?.val as string;

  const numbers = points.flatMap((point) => (typeof point.value === 'number' ? [{ at: new Date(point.at).toISOString(), value: point.value }] : []));
  const scale = chartScale(numbers, key.quantity);
  const y = (value: number) => chartY(value, scale, height - 4) + 2;
  const spans = spansOf(points, window);

  const pick = (x: number) => onCursor(atOf(x, window, width));
  return (
    <YStack gap={4}>
      <XStack justifyContent="space-between" gap="$2">
        <Text fontSize={13} color="$color" flexShrink={1} numberOfLines={1}>
          {key.label}
        </Text>
        <Text fontSize={13} fontWeight="700" color="$color" fontVariant={['tabular-nums']}>
          {now ? said(key, now.value) : '—'}
        </Text>
      </XStack>
      <Track height={height} background={color('background')} onWidth={setWidth} onX={pick} label={`${key.label}: ${points.length} values while it ran`}>
        {width > 0 ? (
          <Svg width={width} height={height} pointerEvents="none">
            {away.map((span) => (
              <Rect key={span.from} x={xOf(span.from, window, width)} y={0} width={Math.max(1, xOf(span.to, window, width) - xOf(span.from, window, width))} height={height} fill={color('warning')} opacity={0.18} />
            ))}
            {key.kind === 'number' ? (
              <>
                {scale.min <= 0 && scale.max >= 0 ? <Line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke={color('borderColor')} strokeWidth={1} /> : null}
                <Path d={heldPath(points, window, width, y)} fill="none" stroke={color('accent')} strokeWidth={2} strokeLinejoin="round" />
              </>
            ) : (
              spans.map((span) => {
                const x = xOf(span.from, window, width);
                const w = Math.max(1, xOf(span.to, window, width) - x);
                const on = span.value === true;
                const known = span.value !== null;
                const text = key.kind === 'boolean' ? null : said(key, span.value);
                return (
                  <G key={span.from}>
                    <Rect x={x} y={2} width={w} height={height - 4} rx={3} fill={on ? color('accent') : color('backgroundPress')} opacity={known ? 1 : 0.4} />
                    {text && w > text.length * 6 + 8 ? (
                      <SvgText x={x + 4} y={height / 2 + 4} fontSize={10} fill={color('color')}>
                        {text}
                      </SvgText>
                    ) : null}
                  </G>
                );
              })
            )}
            {marks.map((mark) => (
              <Line key={mark.n} x1={xOf(mark.at, window, width)} x2={xOf(mark.at, window, width)} y1={0} y2={height} stroke={color('muted')} strokeWidth={1} strokeDasharray="2,3" opacity={0.7} />
            ))}
            {cursor !== null ? <Line x1={xOf(cursor, window, width)} x2={xOf(cursor, window, width)} y1={0} y2={height} stroke={color('color')} strokeWidth={1.5} /> : null}
          </Svg>
        ) : null}
      </Track>
      {key.kind === 'number' && numbers.length ? (
        <XStack justifyContent="space-between">
          <Text fontSize={11} color="$muted">
            low {said(key, scale.trough)}
          </Text>
          <Text fontSize={11} color="$muted">
            high {said(key, scale.peak)}
          </Text>
        </XStack>
      ) : null}
    </YStack>
  );
}

/**
 * The run's ruler: its start and end, and each step that changed something
 * as its number where it happened — what the dashed lines on every chart are.
 */
export function Ruler({ window, marks, cursor, onCursor }: { window: Window; marks: readonly Mark[]; cursor: number | null; onCursor: (at: number) => void }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const color = (name: string) => theme[name]?.val as string;
  return (
    <Track height={26} background="transparent" onWidth={setWidth} onX={(x) => onCursor(atOf(x, window, width))} label={null}>
      {width > 0 ? (
        <Svg width={width} height={26} pointerEvents="none">
          <Line x1={0} x2={width} y1={22} y2={22} stroke={color('borderColor')} strokeWidth={1} />
          {marks.map((mark) => {
            const x = Math.min(width - 9, Math.max(9, xOf(mark.at, window, width)));
            return (
              <G key={mark.n}>
                <Circle cx={x} cy={11} r={9} fill={mark.step.outcome === 'done' || mark.step.outcome === 'already' ? color('accent') : color('warning')} />
                <SvgText x={x} y={15} fontSize={10} fontWeight="700" fill={color('background')} textAnchor="middle">
                  {String(mark.n)}
                </SvgText>
              </G>
            );
          })}
          {cursor !== null ? <Line x1={xOf(cursor, window, width)} x2={xOf(cursor, window, width)} y1={0} y2={26} stroke={color('color')} strokeWidth={1.5} /> : null}
        </Svg>
      ) : null}
    </Track>
  );
}

/**
 * Where a tap or a drag sets the cursor: React Native's own view, whose
 * touch handling works on the web as on a phone — a styled stack's does not
 * reach the web.
 */
function Track({ height, background, onWidth, onX, label, children }: { height: number; background: string; onWidth: (width: number) => void; onX: (x: number) => void; label: string | null; children: ReactNode }) {
  return (
    <View
      style={{ height, borderRadius: 4, overflow: 'hidden', backgroundColor: background, cursor: 'crosshair' } as never}
      onLayout={(event) => onWidth(event.nativeEvent.layout.width)}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(event) => onX(event.nativeEvent.locationX)}
      onResponderMove={(event) => onX(event.nativeEvent.locationX)}
      aria-label={label ?? undefined}
      aria-hidden={label === null || undefined}
    >
      {children}
    </View>
  );
}
