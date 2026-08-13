import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing } from 'react-native';
import { Feather } from '@expo/vector-icons';
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Stop,
} from 'react-native-svg';
import { Text, useTheme, XStack, YStack } from 'tamagui';

import type { StationStatus } from '@kraftverk/protocol';

/**
 * Lives in the device package, not the app.
 *
 * This is the P280's own screen furniture: a cell of liquid with orthogonal
 * legs, droplets whose speed follows the wattage, and a charge-limit tick on
 * the rim. None of it generalises to a smart plug or a weather source, and
 * that is the point — a device with strong opinions about how it should be
 * drawn brings its own drawing, while the app keeps only the generics every
 * device gets for free.
 */

/** Local rather than imported: the package must not depend on the app. */
const formatWatts = (watts: number): string =>
  watts >= 1000 ? `${(watts / 1000).toFixed(2)} kW` : `${Math.round(watts)} W`;

/**
 * `Animated.createAnimatedComponent` adds React Native's `collapsable` prop,
 * which react-native-svg forwards straight to the DOM on web, making React warn
 * on every render. Strip it rather than silencing the warning.
 */
function stripCollapsable<P extends object>(Component: React.ComponentType<P>, name: string) {
  const Wrapped = forwardRef<unknown, P & { collapsable?: boolean }>(
    ({ collapsable, ...rest }, ref) => <Component ref={ref as never} {...(rest as P)} />
  );
  Wrapped.displayName = name;
  return Animated.createAnimatedComponent(Wrapped);
}

const AnimatedG = stripCollapsable<React.ComponentProps<typeof G>>(G, 'PlainG');
const AnimatedPath = stripCollapsable<React.ComponentProps<typeof Path>>(Path, 'PlainPath');
// Still used for the charging pulse ring.
const AnimatedCircle = stripCollapsable<React.ComponentProps<typeof Circle>>(Circle, 'PlainCircle');

/**
 * The dashboard's centrepiece.
 *
 * Four decisions, taken from how this class of app actually reads:
 *
 * 1. **A circle of liquid, not a bar.** Two sine waves at different wavelengths
 *    and speeds drift across the surface, so charge reads as a volume of
 *    something. The waves calm when the station is idle and pick up when power
 *    moves, so state is felt before it is read.
 *
 * 2. **Orthogonal legs with rounded joints.** Curves imply routing that does not
 *    exist. Right angles read as connections, like traces on a board.
 *
 * 3. **Legs merge into a trunk.** Six independent spokes read as noise; two
 *    trunks — one in, one out — read as a system.
 *
 * 4. **Droplets, not dashes.** Discrete particles travel the leg, fading in as
 *    they leave and out as they arrive, so each is visibly emitted and absorbed.
 *    Count and speed follow wattage: a trickle drips, a fast charge streams.
 */

// Design space, rendered through a viewBox and scaled to the container.
const W = 340;
const H = 352;
const CX = W / 2;
const CY = 190;
const R = 58;

/**
 * A badge is the icon disc plus two lines of text, and it hangs *below* its
 * anchor point. Legs therefore have to start clear of it, and the stage has to
 * be tall enough to contain the bottom row — otherwise the badges spill out and
 * collide with whatever the card puts underneath.
 */
const BADGE_H = 66;

const IN_Y = 32;
const OUT_Y = H - BADGE_H - 4;
/** Where the input legs turn and merge, and where the output legs split. */
const TRUNK_IN_Y = 106;
const TRUNK_OUT_Y = 268;
const JOINT_R = 14;

type Point = { x: number; y: number };

type Node = {
  id: string;
  label: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  x: number;
  y: number;
  /** Path in flow order: source first, destination last. */
  points: Point[];
  watts: number;
  inbound: boolean;
};

/**
 * Blend a hex colour toward white. The back wave needs to be a genuinely
 * lighter green, not just a more transparent one — transparency alone reads as
 * "faded", whereas a lighter tint reads as a second body of liquid behind the
 * first, which is what makes the overlap legible.
 */
function lighten(hex: string, amount: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 0xff);
  const g = mix((n >> 8) & 0xff);
  const b = mix(n & 0xff);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

const toRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [34, 197, 94];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

const mixHex = (a: string, b: string, t: number): string => {
  const [r1, g1, b1] = toRgb(a);
  const [r2, g2, b2] = toRgb(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * Math.max(0, Math.min(1, t)));
  const v = (c(r1, r2) << 16) | (c(g1, g2) << 8) | c(b1, b2);
  return `#${((1 << 24) | v).toString(16).slice(1)}`;
};

/**
 * The liquid carries the warning: green when healthy, sliding through amber and
 * into red as the pack empties. Interpolated rather than stepped, so a slow
 * discharge shifts hue gradually instead of snapping at a threshold and looking
 * like a fault.
 *
 * Only the stored energy changes colour. Inbound droplets stay green because
 * they mean "power arriving", which is good news at any state of charge.
 */
function levelColour(level: number, green: string, amber: string, red: string): string {
  if (level >= 55) return green;
  if (level >= 25) return mixHex(amber, green, (level - 25) / 30);
  return mixHex(red, amber, Math.max(0, level - 8) / 17);
}

/** Rounded polyline: straight runs joined by small arcs at each corner. */
function polyPath(points: Point[]): string {
  if (points.length < 2) return '';
  const len = (p: Point, q: Point) => Math.hypot(q.x - p.x, q.y - p.y) || 1;

  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]!;
    const corner = points[i]!;
    const next = points[i + 1]!;
    const r1 = Math.min(JOINT_R, len(prev, corner) / 2);
    const r2 = Math.min(JOINT_R, len(corner, next) / 2);
    const a = {
      x: corner.x + ((prev.x - corner.x) / len(prev, corner)) * r1,
      y: corner.y + ((prev.y - corner.y) / len(prev, corner)) * r1,
    };
    const b = {
      x: corner.x + ((next.x - corner.x) / len(corner, next)) * r2,
      y: corner.y + ((next.y - corner.y) / len(corner, next)) * r2,
    };
    d += ` L ${a.x} ${a.y} Q ${corner.x} ${corner.y} ${b.x} ${b.y}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

/** Distance-proportional stops, so a droplet moves at constant speed. */
function stops(points: Point[]) {
  const segs = points.slice(1).map((p, i) => Math.hypot(p.x - points[i]!.x, p.y - points[i]!.y));
  const total = segs.reduce((a, b) => a + b, 0) || 1;
  let run = 0;
  return points.map((_, i) => {
    if (i === 0) return 0;
    run += segs[i - 1]!;
    return run / total;
  });
}

export function EnergyFlow({
  status,
  chargeLimit,
}: {
  status: StationStatus;
  chargeLimit?: number;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(W);

  const accent = theme.success?.val ?? '#22c55e';
  const load = theme.warning?.val ?? '#f59e0b';
  const danger = theme.danger?.val ?? '#ef4444';
  const track = theme.backgroundPress?.val ?? '#1e2430';
  const muted = theme.muted?.val ?? '#64748b';

  /** Green when healthy, amber then red as the pack empties. */
  const liquid = levelColour(status.level, accent, load, danger);

  const ports = Object.fromEntries(status.ports.map((p) => [p.id, p]));
  const charging = status.state === 'charging';
  const busy = status.totalInputWatts > 5 || status.totalOutputWatts > 5;

  const nodes = useMemo<Node[]>(() => {
    const inX = [W * 0.16, W * 0.84];
    const outX = [W * 0.11, W * 0.37, W * 0.63, W * 0.89];

    const inbound = (
      id: string,
      label: string,
      icon: Node['icon'],
      x: number,
      watts: number
    ): Node => ({
      id,
      label,
      icon,
      x,
      y: IN_Y,
      watts,
      inbound: true,
      // Starts below the badge, drops, turns inward to the trunk, then down
      // into the cell.
      points: [
        { x, y: IN_Y + BADGE_H - 14 },
        { x, y: TRUNK_IN_Y },
        { x: CX, y: TRUNK_IN_Y },
        { x: CX, y: CY - R },
      ],
    });

    const outbound = (
      id: string,
      label: string,
      icon: Node['icon'],
      x: number,
      watts: number,
      index: number
    ): Node => ({
      id,
      label,
      icon,
      x,
      y: OUT_Y,
      watts,
      inbound: false,
      /*
        One shared rail, not a lane each. Every port drops from the same
        horizontal line by a short stub, so the four read as taps off one bus
        rather than as separate branches at different depths. Verticals leave
        the rail downward, so they meet it at a junction rather than crossing
        another leg's run.
      */
      points: [
        { x: CX, y: CY + R },
        { x: CX, y: TRUNK_OUT_Y },
        { x, y: TRUNK_OUT_Y },
        { x, y: OUT_Y - 19 },
      ],
    });

    return [
      inbound('grid', 'Grid', 'zap', inX[0]!, status.acInputWatts),
      inbound('solar', 'Solar', 'sun', inX[1]!, status.solarInputWatts),
      outbound('ac', 'AC', 'power', outX[0]!, ports.ac?.enabled ? ports.ac.watts : 0, 0),
      outbound('dc', 'DC', 'truck', outX[1]!, ports.dc?.enabled ? ports.dc.watts : 0, 1),
      outbound('usb', 'USB', 'smartphone', outX[2]!, ports.usb?.enabled ? ports.usb.watts : 0, 2),
      outbound('led', 'Light', 'sun', outX[3]!, ports.led?.enabled ? ports.led.watts : 0, 3),
    ];
  }, [status, ports]);

  const scale = width / W;

  return (
    <YStack
      width="100%"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      height={H * scale}
      position="relative"
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${W} ${H}`}>
        <Defs>
          <LinearGradient id="liquid" x1="0" y1="1" x2="0" y2="0">
            <Stop offset="0" stopColor={liquid} stopOpacity="0.55" />
            <Stop offset="1" stopColor={liquid} stopOpacity="0.95" />
          </LinearGradient>
          {/* Vignette: transparent through the middle, darkening at the rim.
              Without it a nearly-full cell reads as a flat disc of colour;
              with it, it reads as a glass holding something. */}
          <RadialGradient id="glass" cx="38%" cy="30%" r="78%">
            <Stop offset="0" stopColor="#ffffff" stopOpacity="0.16" />
            <Stop offset="0.55" stopColor="#ffffff" stopOpacity="0.02" />
            <Stop offset="1" stopColor="#000000" stopOpacity="0.3" />
          </RadialGradient>
          <ClipPath id="cellClip">
            <Circle cx={CX} cy={CY} r={R} />
          </ClipPath>
        </Defs>

        {nodes.map((node) => (
          <Path
            key={`leg-${node.id}`}
            d={polyPath(node.points)}
            stroke={track}
            strokeWidth={2}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        <Cell
          level={status.level}
          chargeLimit={chargeLimit}
          busy={busy}
          charging={charging}
          track={track}
          muted={muted}
          accent={accent}
          liquid={liquid}
        />

        {nodes.map((node) => (
          <Droplets key={`d-${node.id}`} node={node} tint={node.inbound ? accent : load} />
        ))}
      </Svg>

      {/* Readout overlays the drawing so it inherits the app's type styles */}
      <YStack
        position="absolute"
        left={0}
        top={(CY - 42) * scale}
        width="100%"
        alignItems="center"
        pointerEvents="none"
        gap={2}
      >
        <XStack alignItems="baseline">
          <Text
            fontSize={40 * Math.min(scale, 1.15)}
            fontWeight="800"
            letterSpacing={-1.8}
            color="$color"
          >
            {Math.round(status.level)}
          </Text>
          <Text fontSize={17 * Math.min(scale, 1.15)} fontWeight="700" color="$color" opacity={0.7}>
            %
          </Text>
        </XStack>
        {chargeLimit !== undefined && chargeLimit < 100 ? (
          <Text fontSize={10 * Math.min(scale, 1.2)} fontWeight="700" color="$color" opacity={0.55}>
            AC to {chargeLimit}%
          </Text>
        ) : null}
      </YStack>

      {nodes.map((node) => (
        <NodeBadge
          key={`b-${node.id}`}
          node={node}
          scale={scale}
          tint={node.inbound ? accent : load}
        />
      ))}
    </YStack>
  );
}

/** One wave period repeated, closed downward so it can be filled. */
function wavePath(wavelength: number, amplitude: number, periods: number, depth: number): string {
  const half = wavelength / 2;
  const q = wavelength / 4;
  let d = `M 0 0`;
  for (let i = 0; i < periods; i++) {
    d += ` q ${q} ${-amplitude} ${half} 0 q ${q} ${amplitude} ${half} 0`;
  }
  d += ` L ${wavelength * periods} ${depth} L 0 ${depth} Z`;
  return d;
}

/** The cell: a circle of liquid, with the AC charge limit marked on the rim. */
function Cell({
  level,
  chargeLimit,
  busy,
  charging,
  track,
  muted,
  accent,
  liquid,
}: {
  level: number;
  chargeLimit?: number;
  busy: boolean;
  charging: boolean;
  track: string;
  muted: string;
  accent: string;
  /** Level-derived colour of the stored energy. */
  liquid: string;
}) {
  const surface = useRef(new Animated.Value(level)).current;
  const driftA = useRef(new Animated.Value(0)).current;
  const driftB = useRef(new Animated.Value(0)).current;

  const amplitude = busy ? 5 : 2.2;
  const speedA = busy ? 2800 : 5600;
  const speedB = busy ? 4100 : 7600;

  useEffect(() => {
    Animated.spring(surface, {
      toValue: level,
      damping: 16,
      stiffness: 65,
      useNativeDriver: false,
    }).start();
  }, [level, surface]);

  useEffect(() => {
    const run = (value: Animated.Value, duration: number, reverse: boolean) => {
      value.setValue(reverse ? 1 : 0);
      const loop = Animated.loop(
        Animated.timing(value, {
          toValue: reverse ? 0 : 1,
          duration,
          easing: Easing.linear,
          useNativeDriver: false,
        })
      );
      loop.start();
      return loop;
    };
    const a = run(driftA, speedA, false);
    const b = run(driftB, speedB, true);
    return () => {
      a.stop();
      b.stop();
    };
  }, [driftA, driftB, speedA, speedB]);

  // Leave a sliver at the top so a full cell still shows a surface.
  const surfaceY = surface.interpolate({
    inputRange: [0, 100],
    outputRange: [CY + R, CY - R + 3],
    extrapolate: 'clamp',
  });

  // Drift is folded into the group's animated x. `translateX` is not a valid
  // <G> prop and leaks to the DOM on web, which React warns about.
  const waveA = R * 1.15;
  const waveB = R * 0.8;
  const originX = CX - R * 2;
  const shiftA = driftA.interpolate({
    inputRange: [0, 1],
    outputRange: [originX, originX - waveA],
  });
  const shiftB = driftB.interpolate({
    inputRange: [0, 1],
    outputRange: [originX - waveB, originX],
  });

  /*
    The limit mark sits at the height the liquid would reach, not at an angle
    around the rim. A radial gauge disagreed with a vertical fill: the tick for
    73% landed on the left-hand side while the water sat near the top, which
    read as an unrelated stray mark.
  */
  const limit =
    chargeLimit !== undefined && chargeLimit < 100
      ? (() => {
          const y = CY + R - (2 * R * chargeLimit) / 100;
          const dx = Math.sqrt(Math.max(0, R * R - (y - CY) * (y - CY)));
          return { y, dx };
        })()
      : null;

  return (
    <>
      <Circle cx={CX} cy={CY} r={R} fill={track} />

      <G clipPath="url(#cellClip)">
        {/*
          Two bodies of liquid, not one wave. The back one is a lighter green,
          shorter wavelength, drifting the other way and sitting slightly
          higher. Where they cross, the front reads as nearer — that parallax is
          what makes it look like liquid rather than a moving line.
        */}
        <AnimatedG x={shiftB} y={surfaceY}>
          <Path
            d={wavePath(waveB, amplitude * 0.7, 6, R * 2 + 20)}
            fill={lighten(liquid, 0.42)}
            fillOpacity={0.55}
          />
        </AnimatedG>
        <AnimatedG x={shiftA} y={surfaceY}>
          <Path d={wavePath(waveA, amplitude, 6, R * 2 + 20)} fill="url(#liquid)" />
        </AnimatedG>
      </G>

      {/* Glass over the liquid, then the rim on top */}
      <Circle cx={CX} cy={CY} r={R} fill="url(#glass)" />
      <Circle
        cx={CX}
        cy={CY}
        r={R}
        fill="none"
        stroke={muted}
        strokeOpacity={0.3}
        strokeWidth={2}
      />

      {/* AC charge limit: ticks either side of the rim at the level the liquid
          would reach. Drawn across the liquid it vanished whenever the pack sat
          above the limit. */}
      {limit ? (
        <>
          <Path
            d={`M ${CX - limit.dx - 9} ${limit.y} L ${CX - limit.dx + 2} ${limit.y}`}
            stroke={muted}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          <Path
            d={`M ${CX + limit.dx - 2} ${limit.y} L ${CX + limit.dx + 9} ${limit.y}`}
            stroke={muted}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
        </>
      ) : null}

      {charging ? <ChargePulse accent={accent} /> : null}
    </>
  );
}

/** A ring that expands and fades out of the cell while charging. */
function ChargePulse({ accent }: { accent: string }) {
  const t = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(t, {
        toValue: 1,
        duration: 2200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [t]);

  const r = t.interpolate({ inputRange: [0, 1], outputRange: [R, R + 16] });
  const opacity = t.interpolate({ inputRange: [0, 0.25, 1], outputRange: [0, 0.35, 0] });

  return (
    <AnimatedCircle cx={CX} cy={CY} r={r} fill="none" stroke={accent} strokeWidth={2} opacity={opacity} />
  );
}

/** Particles travelling the leg, emitted and absorbed. */
function Droplets({ node, tint }: { node: Node; tint: string }) {
  const active = node.watts > 0.5;
  const count = node.watts > 400 ? 3 : node.watts > 60 ? 2 : 1;
  const duration = Math.max(1100, 3200 - Math.min(node.watts, 1800));

  const d = polyPath(node.points);
  const length = node.points
    .slice(1)
    .reduce((sum, p, i) => sum + Math.hypot(p.x - node.points[i]!.x, p.y - node.points[i]!.y), 0);

  if (!active) return null;

  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <Droplet
          key={i}
          node={node}
          tint={tint}
          duration={duration}
          delay={(duration / count) * i}
          d={d}
          length={length}
        />
      ))}
    </>
  );
}

function Droplet({
  node,
  tint,
  duration,
  delay,
  d,
  length,
}: {
  node: Node;
  tint: string;
  duration: number;
  delay: number;
  /** The leg's own path data — the droplet rides this exact geometry. */
  d: string;
  length: number;
}) {
  const t = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    // Stagger with a one-off timeout, not Animated.delay, which would re-apply
    // the delay every iteration and bunch the droplets together.
    const handle = setTimeout(() => {
      loop = Animated.loop(
        Animated.timing(t, {
          toValue: 1,
          duration,
          easing: Easing.linear,
          useNativeDriver: false,
        })
      );
      loop.start();
    }, delay);

    return () => {
      clearTimeout(handle);
      loop?.stop();
      t.setValue(0);
    };
  }, [t, duration, delay]);

  // A quick independent throb, so droplets feel alive rather than rigid.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 520, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 520, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  /*
    The droplet is a single short dash riding the leg's own path.

    Rotating a teardrop shape along interpolated coordinates never tracked the
    geometry — react-native-svg does not reliably animate `rotation`, and even
    when it did, the shape only pointed the right way on the straights. A dash
    with `strokeDashoffset` follows the exact path, corners included, for free.
    Round caps make it a bead rather than a segment, so it reads as something
    moving through a pipe.

    The gap is the full path length, so exactly one bead is ever on the leg.
  */
  const head = 11;
  const offset = t.interpolate({
    inputRange: [0, 1],
    outputRange: [head, -(length + head)],
  });

  // Strong along the run, dissolving as it is absorbed at the far end.
  const opacity = node.inbound
    ? t.interpolate({ inputRange: [0, 0.12, 0.6, 1], outputRange: [0, 1, 0.95, 0] })
    : t.interpolate({ inputRange: [0, 0.4, 0.9, 1], outputRange: [0, 0.95, 1, 0] });

  // A slow throb in width, so the bead breathes instead of sliding rigidly.
  const strokeWidth = pulse.interpolate({ inputRange: [0, 1], outputRange: [5, 6.6] });

  return (
    <>
      {/* Faint trail behind the head */}
      <AnimatedPath
        d={d}
        stroke={tint}
        strokeWidth={2.5}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={`${head * 2.4} ${length}`}
        strokeDashoffset={offset}
        opacity={Animated.multiply(opacity, 0.35)}
      />
      <AnimatedPath
        d={d}
        stroke={tint}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        fill="none"
        strokeDasharray={`${head} ${length}`}
        strokeDashoffset={offset}
        opacity={opacity}
      />
    </>
  );
}

/** Circular button, label and wattage at the end of each leg. */
function NodeBadge({ node, scale, tint }: { node: Node; scale: number; tint: string }) {
  const theme = useTheme();
  const active = node.watts > 0.5;
  const BOX = 78;
  const DOT = 34;

  return (
    <YStack
      pointerEvents="none"
      position="absolute"
      left={node.x * scale - (BOX * scale) / 2}
      top={(node.y - 17) * scale}
      width={BOX * scale}
      alignItems="center"
      gap={3 * scale}
    >
      <YStack
        width={DOT * scale}
        height={DOT * scale}
        borderRadius={999}
        alignItems="center"
        justifyContent="center"
        backgroundColor="$backgroundStrong"
        borderWidth={1.5}
        borderColor={active ? tint : '$borderColor'}
      >
        <Feather
          name={node.icon}
          size={15 * Math.min(scale, 1.1)}
          color={active ? tint : (theme.muted?.val ?? '#888')}
        />
      </YStack>
      <Text fontSize={10 * Math.min(scale, 1.15)} fontWeight="700" color="$muted">
        {node.label}
      </Text>
      <Text
        fontSize={12 * Math.min(scale, 1.15)}
        fontWeight={active ? '800' : '600'}
        color={active ? '$color' : '$muted'}
        fontVariant={['tabular-nums']}
      >
        {active ? formatWatts(node.watts) : '0 W'}
      </Text>
    </YStack>
  );
}
