import { useEffect, useRef } from 'react';
import { Feather } from '@expo/vector-icons';
import { Animated } from 'react-native';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import type { DeviceScreenProps } from '@kraftverk/api-client';
import { AnimatedNumber, Card, PowerButton, StatTile, Toggle } from '@kraftverk/ui';

import { useLive, usePlug, type Live, type Plug } from './plug';
import { clock, cutOf, safetySummary, trim, type Cut } from './words';

const AFTER_A_CUT: Record<string, string> = {
  asItWas: 'After a power cut it goes back to how it was.',
  on: 'After a power cut it always comes back on.',
  off: 'After a power cut it stays off until someone switches it on.',
};

/**
 * The ATORCH at a glance: is it on, what is it drawing, is the supply healthy,
 * and — when it switched itself off — why, and when it comes back.
 *
 * Content only: the page frame, the name and the history below are the app's.
 */
export function PlugDashboard(props: DeviceScreenProps) {
  const plug = usePlug(props);
  const live = useLive(plug);

  if (!props.device.readings.length) {
    return (
      <Card alignItems="center" paddingVertical="$8" gap="$4">
        <Spinner size="large" color="$accent" />
        <Text color="$muted" fontSize={13} textAlign="center" lineHeight={19}>
          {props.reach.waiting}
        </Text>
      </Card>
    );
  }

  const cut = cutOf(plug.value);
  return (
    <YStack gap="$4">
      {cut ? <CutCard cut={cut} plug={plug} /> : null}
      <Hero plug={plug} live={live} cut={cut} />
      <Tiles plug={plug} />
      <Safety plug={plug} />
    </YStack>
  );
}

function Hero({ plug, live, cut }: { plug: Plug; live: Live; cut: Cut | null }) {
  const on = plug.value('relay') === true;
  const watts = plug.number('watts');
  const volts = plug.number('volts');
  const amps = plug.number('amps');
  const drawing = watts !== null && watts >= 1;
  const status = on ? (drawing ? 'On — powering what is plugged in' : 'On — nothing is drawing') : cut ? 'Off — it switched itself off' : 'Off';

  return (
    <Card padding="$5" gap="$4">
      <XStack alignItems="center" gap="$4">
        <YStack flex={1} gap={6}>
          <Text fontSize={13} fontWeight="600" color={on ? '$success' : '$muted'}>
            {status}
          </Text>
          <XStack alignItems="baseline" gap={6} aria-label={watts === null ? undefined : `Drawing ${trim(watts, watts < 10 ? 1 : 0)} W`}>
            {watts === null ? (
              <Text fontSize={52} lineHeight={60} fontWeight="700" color="$color">
                —
              </Text>
            ) : (
              <AnimatedNumber value={watts} fontSize={52} fontWeight="700" color={on ? '$color' : '$muted'} format={(v) => trim(v, v < 10 ? 1 : 0)} />
            )}
            <Text fontSize={22} fontWeight="600" color="$muted">
              W
            </Text>
          </XStack>
          <Text fontSize={13} color="$muted" fontVariant={['tabular-nums']}>
            {[volts === null ? null : `${trim(volts)} V`, amps === null ? null : `${trim(amps, 2)} A`].filter(Boolean).join('  ·  ') || 'Waiting for its first reading'}
          </Text>
        </YStack>
        <PowerButton on={on} label="Power" pending={plug.pending('relay')} disabled={!plug.canChange} onChange={(next) => void plug.switchTo(next)} />
      </XStack>

      <LiveStrip live={live} disabled={!plug.canChange} />

      {plug.error ? (
        <Text fontSize={13} color="$danger" lineHeight={18}>
          {plug.error}
        </Text>
      ) : null}
    </Card>
  );
}

/** A dot that breathes while readings arrive every second. */
function Pulse({ active }: { active: boolean }) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 700, useNativeDriver: false }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: false }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [active, opacity]);
  return (
    <Animated.View
      style={{ width: 10, height: 10, borderRadius: 5, opacity, backgroundColor: active ? (theme.success?.val as string) : (theme.muted?.val as string) }}
    />
  );
}

function LiveStrip({ live, disabled }: { live: Live; disabled: boolean }) {
  const title = live.on ? 'Live' : 'Live readings';
  const detail = live.on
    ? live.kept
      ? 'A reading every second, for as long as you are here.'
      : `A reading every second for ${clock(live.left ?? 0)} more.`
    : 'A reading every second while you watch — for when you are changing something.';
  return (
    <XStack alignItems="center" gap="$3" backgroundColor="$background" borderRadius="$4" paddingHorizontal="$3" paddingVertical={10}>
      <Pulse active={live.on} />
      <YStack flex={1} gap={1}>
        <Text fontSize={14} fontWeight="700" color="$color">
          {title}
        </Text>
        <Text fontSize={12} color="$muted" lineHeight={16}>
          {detail}
        </Text>
      </YStack>
      <Toggle label="Live readings" checked={live.on || (live.kept && live.pending)} pending={live.pending} disabled={disabled} onCheckedChange={live.set} />
    </XStack>
  );
}

function CutCard({ cut, plug }: { cut: Cut; plug: Plug }) {
  const theme = useTheme();
  const after = plug.number('backOnAfter');
  const total = after === null ? null : after * 60;
  return (
    <Card padding="$4" gap="$3" borderWidth={1} borderColor="$warning">
      <XStack alignItems="center" gap="$2">
        <Feather name={cut.byRule ? 'clock' : 'shield'} size={18} color={theme.warning?.val as string} />
        <Text fontSize={16} fontWeight="700" color="$color" flex={1}>
          {cut.title}
        </Text>
      </XStack>
      <Text fontSize={14} color="$color" lineHeight={20}>
        {cut.body}
      </Text>
      {cut.backIn !== null ? (
        <YStack gap={6}>
          <Text fontSize={13} fontWeight="600" color="$warning" fontVariant={['tabular-nums']}>
            Back on in {clock(cut.backIn)}
          </Text>
          {total ? (
            <YStack height={6} borderRadius={3} backgroundColor="$backgroundPress" overflow="hidden">
              <YStack height={6} borderRadius={3} backgroundColor="$warning" width={`${Math.round((1 - cut.backIn / total) * 100)}%`} />
            </YStack>
          ) : null}
        </YStack>
      ) : null}
      {cut.byRule ? (
        <XStack gap="$2" flexWrap="wrap">
          <Button size="$3" backgroundColor="$accent" color="$background" fontWeight="700" disabled={!plug.canChange} onPress={() => void plug.switchTo(true)}>
            Switch it on
          </Button>
          <Button
            size="$3"
            chromeless
            borderWidth={1}
            borderColor="$borderColor"
            disabled={!plug.canChange}
            onPress={() => void plug.write({ rule: 'none' }).then(() => plug.switchTo(true))}
          >
            Stop the plug’s own rule
          </Button>
        </XStack>
      ) : null}
    </Card>
  );
}

function Tiles({ plug }: { plug: Plug }) {
  const theme = useTheme();
  const volts = plug.number('volts');
  const low = plug.number('minVoltage');
  const high = plug.number('maxVoltage');
  const amps = plug.number('amps');
  const maxAmps = plug.number('maxCurrent');
  const temperature = plug.number('temperature');
  const kwh = plug.number('kwh');
  const hz = plug.number('hz');
  const pf = plug.number('powerFactor');
  const guarded = plug.value('safetyCutOff') !== false;

  const nearLimit = volts !== null && low !== null && high !== null && (volts - low < 10 || high - volts < 10);
  const icon = (name: 'activity' | 'trending-up' | 'thermometer' | 'bar-chart-2' | 'radio' | 'percent') => <Feather name={name} size={13} color={theme.muted?.val as string} />;

  return (
    <XStack flexWrap="wrap" gap="$3">
      <StatTile
        label="Voltage"
        icon={icon('activity')}
        value={volts === null ? '—' : trim(volts)}
        unit="V"
        position={guarded && volts !== null && low !== null && high !== null ? (volts - low) / (high - low) : null}
        note={guarded && low !== null && high !== null ? `Safe between ${trim(low)} and ${trim(high)} V` : null}
        tone={nearLimit ? 'warning' : 'normal'}
      />
      <StatTile
        label="Current"
        icon={icon('trending-up')}
        value={amps === null ? '—' : trim(amps, 2)}
        unit="A"
        position={guarded && amps !== null && maxAmps ? amps / maxAmps : null}
        note={guarded && maxAmps ? `Cuts above ${trim(maxAmps, 2)} A` : null}
      />
      <StatTile label="Energy" icon={icon('bar-chart-2')} value={kwh === null ? '—' : trim(kwh, 2)} unit="kWh" note="Counted by the plug, in total" />
      <StatTile
        label="Inside the plug"
        icon={icon('thermometer')}
        value={temperature === null ? '—' : trim(temperature, 0)}
        unit="°C"
        tone={temperature !== null && temperature >= 70 ? 'danger' : temperature !== null && temperature >= 60 ? 'warning' : 'normal'}
        note={temperature !== null && temperature >= 60 ? 'Hot: check what is plugged in' : null}
      />
      <StatTile label="Frequency" icon={icon('radio')} value={hz === null ? '—' : trim(hz, 2)} unit="Hz" />
      <StatTile label="Power factor" icon={icon('percent')} value={pf === null ? '—' : trim(pf, 2)} note="1 means every watt drawn does work" />
    </XStack>
  );
}

function Safety({ plug }: { plug: Plug }) {
  const theme = useTheme();
  const afterCut = plug.value('afterPowerCut');
  const guarded = plug.value('safetyCutOff') !== false;
  return (
    <Card padding="$4" gap="$2">
      <XStack alignItems="center" gap="$2">
        <Feather name="shield" size={16} color={(guarded ? theme.success?.val : theme.warning?.val) as string} />
        <Text fontSize={15} fontWeight="700" color="$color">
          Safety
        </Text>
      </XStack>
      <Text fontSize={13} color="$color" lineHeight={19}>
        {safetySummary(plug.value)}
      </Text>
      {typeof afterCut === 'string' && AFTER_A_CUT[afterCut] ? (
        <Text fontSize={13} color={afterCut === 'off' ? '$warning' : '$muted'} lineHeight={19}>
          {AFTER_A_CUT[afterCut]}
        </Text>
      ) : null}
      <Text fontSize={12} color="$muted">
        Change these under Settings.
      </Text>
    </Card>
  );
}

