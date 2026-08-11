import { forwardRef, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Svg, { Circle, Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { Text, useTheme, XStack, YStack } from 'tamagui';

import { formatWatts } from '../lib/format';
import type { StationStatus } from '../lib/types';

/**
 * `Animated.createAnimatedComponent` adds React Native's `collapsable` prop,
 * which react-native-svg forwards straight to the DOM element on web. React
 * then warns about a non-boolean attribute on every render. Strip it here
 * rather than silencing the warning, which would hide real ones too.
 */
type PathProps = React.ComponentProps<typeof Path> & { collapsable?: boolean };
const PlainPath = forwardRef<Path, PathProps>(({ collapsable, ...rest }, ref) => (
  <Path ref={ref} {...rest} />
));
PlainPath.displayName = 'PlainPath';

type CircleProps = React.ComponentProps<typeof Circle> & { collapsable?: boolean };
const PlainCircle = forwardRef<Circle, CircleProps>(({ collapsable, ...rest }, ref) => (
  <Circle ref={ref} {...rest} />
));
PlainCircle.displayName = 'PlainCircle';

const AnimatedPath = Animated.createAnimatedComponent(PlainPath);
const AnimatedCircle = Animated.createAnimatedComponent(PlainCircle);

/**
 * The dashboard's centrepiece: where power is coming from, where it is going,
 * and how fast.
 *
 * Sources feed the battery from above, loads draw from below. Each active path
 * animates a dashed stroke toward the battery or away from it, so direction is
 * legible at a glance rather than needing an arrowhead. Dash speed scales with
 * wattage — a trickle crawls, a fast charge races — which turns a number into
 * something you feel.
 *
 * Idle paths stay drawn but dim, so the topology is always visible and the
 * layout never reflows as ports switch on and off.
 */

const W = 320;
/** Tall enough that the bottom badges clear the stage edge. */
const H = 288;
const CX = W / 2;
const CY = H / 2 - 8;
const RING = 58;

type Node = {
  id: string;
  label: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  x: number;
  y: number;
  /** Curve from the node to the battery edge. */
  path: string;
  watts: number;
  /** Into the battery, or out of it. */
  inbound: boolean;
  tint: string;
};

/** Quadratic curve from a node toward the battery centre, stopping at the ring. */
function curveTo(x: number, y: number): string {
  const dx = CX - x;
  const dy = CY - y;
  const len = Math.hypot(dx, dy) || 1;
  // Stop short of the ring so the stroke does not run under it.
  const endX = CX - (dx / len) * (RING + 8);
  const endY = CY - (dy / len) * (RING + 8);
  // Bow the curve outward a little for a softer, less clinical look.
  const midX = (x + endX) / 2 + dy * 0.12;
  const midY = (y + endY) / 2 - dx * 0.12;
  return `M ${x} ${y} Q ${midX} ${midY} ${endX} ${endY}`;
}

export function EnergyFlow({ status }: { status: StationStatus }) {
  const theme = useTheme();

  const success = theme.success?.val ?? '#22c55e';
  const warning = theme.warning?.val ?? '#f59e0b';
  const muted = theme.muted?.val ?? '#64748b';
  const track = theme.backgroundPress?.val ?? '#1e2430';

  const ports = Object.fromEntries(status.ports.map((p) => [p.id, p]));

  const nodes = useMemo<Node[]>(() => {
    const spec: Omit<Node, 'path'>[] = [
      {
        id: 'ac-in',
        label: 'Grid',
        icon: 'zap',
        x: 46,
        y: 42,
        watts: status.acInputWatts,
        inbound: true,
        tint: success,
      },
      {
        id: 'solar',
        label: 'Solar',
        icon: 'sun',
        x: W - 46,
        y: 42,
        watts: status.solarInputWatts,
        inbound: true,
        tint: success,
      },
      {
        id: 'ac',
        label: 'AC',
        icon: 'power',
        x: 38,
        y: H - 66,
        watts: ports.ac?.enabled ? ports.ac.watts : 0,
        inbound: false,
        tint: warning,
      },
      {
        id: 'dc',
        label: 'DC',
        icon: 'truck',
        x: CX - 48,
        y: H - 36,
        watts: ports.dc?.enabled ? ports.dc.watts : 0,
        inbound: false,
        tint: warning,
      },
      {
        id: 'usb',
        label: 'USB',
        icon: 'smartphone',
        x: CX + 48,
        y: H - 36,
        watts: ports.usb?.enabled ? ports.usb.watts : 0,
        inbound: false,
        tint: warning,
      },
      {
        id: 'led',
        label: 'Light',
        icon: 'sun',
        x: W - 38,
        y: H - 66,
        watts: ports.led?.enabled ? ports.led.watts : 0,
        inbound: false,
        tint: warning,
      },
    ];
    return spec.map((n) => ({ ...n, path: curveTo(n.x, n.y) }));
  }, [status, success, warning, ports]);

  return (
    // Fixed-size stage: the badges are absolutely positioned in SVG
    // coordinates, so they must share an origin with the SVG rather than with a
    // full-width parent that centres it.
    <YStack width={W} height={H} position="relative" alignSelf="center">
      <Svg width={W} height={H}>
        <Defs>
          <LinearGradient id="ringFill" x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0" stopColor={success} stopOpacity="0.9" />
            <Stop offset="1" stopColor={success} stopOpacity="0.55" />
          </LinearGradient>
        </Defs>

        {nodes.map((node) => (
          <FlowPath key={node.id} node={node} idleColor={track} />
        ))}

        <SocRing level={status.level} track={track} muted={muted} />
      </Svg>

      {/* Centre readout, overlaid rather than drawn as SVG text so it inherits
          the app's font and theme without duplicating type styles. */}
      <YStack
        position="absolute"
        top={CY - 32}
        left={0}
        width={W}
        alignItems="center"
        pointerEvents="none"
      >
        <XStack alignItems="baseline" gap={2}>
          <Text fontSize={44} fontWeight="800" letterSpacing={-2} color="$color">
            {Math.round(status.level)}
          </Text>
          <Text fontSize={18} fontWeight="700" color="$muted">
            %
          </Text>
        </XStack>
        <Text fontSize={11} fontWeight="700" color="$muted" letterSpacing={0.6}>
          {status.state === 'charging'
            ? 'CHARGING'
            : status.state === 'discharging'
              ? 'ON BATTERY'
              : status.state.toUpperCase()}
        </Text>
      </YStack>

      {nodes.map((node) => (
        <NodeBadge key={node.id} node={node} />
      ))}
    </YStack>
  );
}

/** A dashed stroke that marches along the path while power is flowing. */
function FlowPath({ node, idleColor }: { node: Node; idleColor: string }) {
  const active = node.watts > 0.5;
  const offset = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      offset.stopAnimation();
      offset.setValue(0);
      return;
    }

    // Faster flow for more power, clamped so a 2 kW load stays legible.
    const duration = Math.max(420, 2200 - Math.min(node.watts, 2000));

    const loop = Animated.loop(
      Animated.timing(offset, {
        // Inbound travels toward the battery, outbound away from it.
        toValue: node.inbound ? -16 : 16,
        duration,
        easing: Easing.linear,
        // strokeDashoffset is not a transform, so it cannot use the native driver.
        useNativeDriver: false,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [active, node.watts, node.inbound, offset]);

  return (
    <>
      <Path d={node.path} stroke={idleColor} strokeWidth={3} fill="none" strokeLinecap="round" />
      {active ? (
        <AnimatedPath
          d={node.path}
          stroke={node.tint}
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
          strokeDasharray="4 12"
          strokeDashoffset={offset}
        />
      ) : null}
    </>
  );
}

/** Circular state-of-charge gauge that eases to new values. */
function SocRing({ level, track, muted }: { level: number; track: string; muted: string }) {
  const circumference = 2 * Math.PI * RING;
  const progress = useRef(new Animated.Value(level)).current;

  useEffect(() => {
    Animated.spring(progress, {
      toValue: level,
      damping: 18,
      stiffness: 90,
      mass: 1,
      useNativeDriver: false,
    }).start();
  }, [level, progress]);

  const dashoffset = progress.interpolate({
    inputRange: [0, 100],
    outputRange: [circumference, 0],
    extrapolate: 'clamp',
  });

  return (
    <>
      <Circle cx={CX} cy={CY} r={RING} stroke={track} strokeWidth={8} fill="none" />
      <AnimatedCircle
        cx={CX}
        cy={CY}
        r={RING}
        stroke="url(#ringFill)"
        strokeWidth={8}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashoffset}
        // Start the arc at 12 o'clock rather than 3.
        transform={`rotate(-90 ${CX} ${CY})`}
      />
      <Circle cx={CX} cy={CY} r={RING - 12} stroke={muted} strokeOpacity={0.08} strokeWidth={1} fill="none" />
    </>
  );
}

/** The label and wattage sitting at the end of each path. */
function NodeBadge({ node }: { node: Node }) {
  const theme = useTheme();
  const active = node.watts > 0.5;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: Platform.OS !== 'web',
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: Platform.OS !== 'web',
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: node.x - 34,
        top: node.y - 20,
        width: 68,
        alignItems: 'center',
        transform: [{ scale }],
      }}
    >
      <XStack
        alignItems="center"
        gap={4}
        paddingHorizontal={7}
        paddingVertical={3}
        borderRadius={999}
        backgroundColor={active ? '$backgroundStrong' : 'transparent'}
        borderWidth={1}
        borderColor={active ? node.tint : 'transparent'}
      >
        <Feather
          name={node.icon}
          size={11}
          color={active ? node.tint : (theme.muted?.val ?? '#888')}
        />
        <Text fontSize={10} fontWeight="700" color={active ? '$color' : '$muted'}>
          {node.label}
        </Text>
      </XStack>
      <Text
        fontSize={11}
        fontWeight={active ? '700' : '500'}
        color={active ? '$color' : '$muted'}
        fontVariant={['tabular-nums']}
      >
        {active ? formatWatts(node.watts) : '—'}
      </Text>
    </Animated.View>
  );
}
