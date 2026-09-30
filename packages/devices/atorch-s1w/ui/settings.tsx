import { useEffect, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import type { DeviceScreenProps } from '@kraftverk/api-client';
import { Card, RangeSliderRow, RowSeparator, SectionLabel, SegmentedControl, SliderRow, ToggleRow } from '@kraftverk/ui';

import { LiveStrip, useLive } from './live';
import { usePlug, type Plug } from './plug';
import { loadWarning, minutes, trim, voltageWarning, watts } from './words';

const AFTER_A_CUT = [
  { value: 'asItWas', label: 'As it was' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const;

const AFTER_A_CUT_SAYS: Record<string, string> = {
  asItWas: 'On or off, as it was before the cut.',
  on: 'On, whatever it was before.',
  off: 'Off, until someone switches it on. Whatever it feeds — a station charging — waits.',
};

const DIMMED_SHOWS = [
  { value: 'readings', label: 'Readings' },
  { value: 'clock', label: 'Start screen' },
  { value: 'nothing', label: 'Nothing' },
] as const;

const LANGUAGES = [
  { value: 'english', label: 'English' },
  { value: 'chinese', label: '中文' },
] as const;

/**
 * The ATORCH's settings: what happens after a power cut, its safety cut-off,
 * its screen, and the bill it shows. Its own modes and timers are not offered
 * — kraftverk's automations do that job (src/type.ts says why each is left out).
 *
 * Live readings are a switch at the top, so a change can be watched landing:
 * turn them on, move a limit, and see the plug take it.
 */
export function PlugSettings(props: DeviceScreenProps) {
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

  return (
    <YStack gap="$4">
      <Card padding="$2">
        <LiveStrip live={live} disabled={!plug.canChange} />
      </Card>
      <PowerCut plug={plug} />
      <SafetyCutOff plug={plug} />
      <Display plug={plug} />
      <Bill plug={plug} />
      {plug.error ? (
        <Text fontSize={13} color="$danger" lineHeight={18} paddingHorizontal="$2">
          {plug.error}
        </Text>
      ) : null}
    </YStack>
  );
}

function PowerCut({ plug }: { plug: Plug }) {
  const value = plug.value('afterPowerCut');
  const chosen = typeof value === 'string' ? value : 'asItWas';
  return (
    <YStack gap="$2">
      <SectionLabel>After a power cut</SectionLabel>
      <Card>
        <SegmentedControl
          title="When the mains comes back"
          subtitle={AFTER_A_CUT_SAYS[chosen]}
          value={chosen as (typeof AFTER_A_CUT)[number]['value']}
          options={AFTER_A_CUT}
          disabled={!plug.canChange}
          pending={plug.pending('afterPowerCut')}
          onChange={(next) => void plug.write({ afterPowerCut: next })}
        />
      </Card>
    </YStack>
  );
}

function SafetyCutOff({ plug }: { plug: Plug }) {
  const theme = useTheme();
  const guarded = plug.value('safetyCutOff') !== false;
  const locked = !plug.canChange || !guarded;
  const volts = plug.number('volts');
  const amps = plug.number('amps');
  const drawn = plug.number('watts');
  const low = plug.number('minVoltage') ?? 75;
  const high = plug.number('maxVoltage') ?? 265;

  return (
    <YStack gap="$2">
      <SectionLabel>Safety cut-off</SectionLabel>
      <Card>
        <ToggleRow
          title="Cut the power when something is wrong"
          subtitle={
            guarded
              ? 'Outside these limits the plug switches off by itself, then back on once all is well.'
              : 'Off: nothing protects what is plugged in from a bad supply or too much load.'
          }
          checked={guarded}
          disabled={!plug.canChange}
          pending={plug.pending('safetyCutOff')}
          onCheckedChange={(next) => void plug.write({ safetyCutOff: next })}
        />
        <RowSeparator />
        <RangeSliderRow
          title="Mains voltage"
          subtitle="Mains in Europe is 230 V, and moves a few volts either way."
          value={[low, high]}
          min={50}
          max={275}
          step={1}
          gap={20}
          labels={['Cut below', 'Cut above']}
          format={(v) => `${trim(v)} V`}
          marker={volts === null ? null : { value: volts, label: `${trim(volts, 0)} V now` }}
          warn={([a, b]) => voltageWarning(a, b, volts)}
          disabled={locked}
          pending={plug.pending('minVoltage') || plug.pending('maxVoltage')}
          onCommit={(a, b) => void plug.write({ ...(a === null ? {} : { minVoltage: a }), ...(b === null ? {} : { maxVoltage: b }) })}
        />
        <RowSeparator />
        <SliderRow
          title="Current above"
          subtitle="The most the plug lets through. Its relay is rated for 10 A."
          value={plug.number('maxCurrent') ?? 16}
          min={0.5}
          max={16}
          step={0.5}
          format={(v) => `${trim(v, 2)} A`}
          marker={amps !== null && amps > 0.05 ? { value: amps, label: `${trim(amps, 1)} A now` } : null}
          warn={(v) => loadWarning(v, amps, 'A')}
          disabled={locked}
          pending={plug.pending('maxCurrent')}
          onCommit={(v) => void plug.write({ maxCurrent: v })}
        />
        <RowSeparator />
        <SliderRow
          title="Power above"
          value={plug.number('maxPower') ?? 4500}
          min={100}
          max={4500}
          step={50}
          format={watts}
          marker={drawn !== null && drawn >= 5 ? { value: drawn, label: `${watts(drawn)} now` } : null}
          warn={(v) => loadWarning(v, drawn, 'W')}
          disabled={locked}
          pending={plug.pending('maxPower')}
          onCommit={(v) => void plug.write({ maxPower: v })}
        />
        <RowSeparator />
        <SliderRow
          title="Wait before cutting"
          subtitle="A fault shorter than this is ridden through: a motor starting, a spike."
          value={plug.number('cutAfter') ?? 0.3}
          min={0}
          max={2}
          step={0.1}
          format={(v) => (v === 0 ? 'At once' : `${trim(v)} s`)}
          ends={['At once', '2 s']}
          disabled={locked}
          pending={plug.pending('cutAfter')}
          onCommit={(v) => void plug.write({ cutAfter: v })}
        />
        <RowSeparator />
        <SliderRow
          title="Switch back on"
          subtitle="Once the fault has cleared and stayed cleared this long."
          value={plug.number('backOnAfter') ?? 3}
          min={0}
          max={30}
          step={1}
          format={(v) => (v === 0 ? 'At once' : `after ${minutes(v)}`)}
          ends={['At once', '30 minutes']}
          disabled={locked}
          pending={plug.pending('backOnAfter')}
          onCommit={(v) => void plug.write({ backOnAfter: v })}
        />
      </Card>
      <XStack gap="$2" paddingHorizontal="$2" alignItems="flex-start">
        <Feather name="info" size={13} color={theme.muted?.val as string} style={{ marginTop: 2 }} />
        <Text fontSize={12} color="$muted" lineHeight={17} flex={1}>
          Each limit is checked against what the plug measures now, and kraftverk asks before one that could cut the power is written.
        </Text>
      </XStack>
    </YStack>
  );
}

function Display({ plug }: { plug: Plug }) {
  const locked = !plug.canChange;
  const shows = plug.value('dimmedShows');
  const language = plug.value('language');
  return (
    <YStack gap="$2">
      <SectionLabel>Its screen</SectionLabel>
      <Card>
        <SliderRow
          title="Brightness"
          value={plug.number('brightness') ?? 6}
          min={1}
          max={9}
          ends={['Dim', 'Bright']}
          disabled={locked}
          pending={plug.pending('brightness')}
          onCommit={(v) => void plug.write({ brightness: v })}
        />
        <RowSeparator />
        <SliderRow
          title="Dims after"
          value={plug.number('dimAfter') ?? 60}
          min={3}
          max={99}
          format={(v) => `${v} s`}
          disabled={locked}
          pending={plug.pending('dimAfter')}
          onCommit={(v) => void plug.write({ dimAfter: v })}
        />
        <RowSeparator />
        <SliderRow
          title="Brightness when dimmed"
          value={plug.number('dimmedBrightness') ?? 3}
          min={1}
          max={9}
          ends={['Dim', 'Bright']}
          disabled={locked || shows === 'nothing'}
          pending={plug.pending('dimmedBrightness')}
          onCommit={(v) => void plug.write({ dimmedBrightness: v })}
        />
        <RowSeparator />
        <SegmentedControl
          title="When dimmed, it shows"
          value={(typeof shows === 'string' ? shows : 'readings') as (typeof DIMMED_SHOWS)[number]['value']}
          options={DIMMED_SHOWS}
          disabled={locked}
          pending={plug.pending('dimmedShows')}
          onChange={(next) => void plug.write({ dimmedShows: next })}
        />
        <RowSeparator />
        <ToggleRow
          title="Beep when its button is pressed"
          checked={plug.value('keyBeep') === true}
          disabled={locked}
          pending={plug.pending('keyBeep')}
          onCheckedChange={(next) => void plug.write({ keyBeep: next })}
        />
        <RowSeparator />
        <SegmentedControl
          title="Language on its screen"
          value={(typeof language === 'string' ? language : 'english') as (typeof LANGUAGES)[number]['value']}
          options={LANGUAGES}
          disabled={locked}
          pending={plug.pending('language')}
          onChange={(next) => void plug.write({ language: next })}
        />
        <RowSeparator />
        <ButtonRow
          title="Turn the screen around"
          subtitle="Upside down, or back: for a plug that sits the other way up in its socket."
          label="Turn it"
          icon="rotate-cw"
          disabled={locked}
          onPress={() => plug.press('rotateScreen')}
        />
      </Card>
    </YStack>
  );
}

/** A row whose action happens once: its title and why, and a button. */
function ButtonRow({
  title,
  subtitle,
  label,
  icon,
  tone,
  disabled,
  onPress,
}: {
  title: string;
  subtitle: string;
  label: string;
  icon: 'rotate-cw' | 'rotate-ccw';
  tone?: 'danger';
  disabled: boolean;
  onPress: () => Promise<boolean>;
}) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 2500);
    return () => clearTimeout(timer);
  }, [done]);
  const color = tone === 'danger' ? theme.danger?.val : theme.color?.val;
  return (
    <XStack alignItems="center" gap="$3" paddingHorizontal="$4" paddingVertical="$3" opacity={disabled ? 0.45 : 1}>
      <YStack flex={1} gap={2}>
        <Text fontSize={15} fontWeight="600" color="$color">
          {title}
        </Text>
        <Text fontSize={12} color="$muted" lineHeight={17}>
          {subtitle}
        </Text>
      </YStack>
      <Button
        size="$3"
        disabled={disabled || busy}
        borderColor={tone === 'danger' ? '$danger' : '$borderColor'}
        borderWidth={1}
        color={tone === 'danger' ? '$danger' : '$color'}
        icon={busy ? <Spinner size="small" /> : <Feather name={done ? 'check' : icon} size={14} color={color as string} />}
        onPress={() => {
          setBusy(true);
          void onPress()
            .then((ran) => setDone(ran))
            .finally(() => setBusy(false));
        }}
      >
        {done ? 'Done' : label}
      </Button>
    </XStack>
  );
}

/**
 * What the plug's screen shows as a bill: the energy it counted times a price.
 * kraftverk keeps its own history of the energy; this is only what the plug
 * shows on itself, and its counter can be set back to zero.
 */
function Bill({ plug }: { plug: Plug }) {
  const locked = !plug.canChange;
  const price = plug.number('price');
  const cost = plug.number('cost');
  const kwh = plug.number('kwh');
  const [draft, setDraft] = useState(price === null ? '' : price.toFixed(2));
  useEffect(() => {
    if (!plug.pending('price')) setDraft(price === null ? '' : price.toFixed(2));
    // What was typed is left alone while its write is on its way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [price]);
  const typed = Number(draft.replace(',', '.'));
  const valid = draft.trim() !== '' && Number.isFinite(typed) && typed >= 0 && typed <= 999.99;
  const commit = () => {
    if (valid && Math.round(typed * 100) !== Math.round((price ?? -1) * 100)) void plug.write({ price: Math.round(typed * 100) / 100 });
  };
  return (
    <YStack gap="$2">
      <SectionLabel>The bill on its screen</SectionLabel>
      <Card>
        <XStack alignItems="center" gap="$3" paddingHorizontal="$4" paddingVertical="$3" opacity={locked ? 0.45 : 1}>
          <YStack flex={1} gap={2}>
            <Text fontSize={15} fontWeight="600" color="$color">
              Price per kWh
            </Text>
            <Text fontSize={12} color="$muted" lineHeight={17}>
              In your own currency: the plug keeps no unit.
            </Text>
          </YStack>
          <Input
            width={110}
            size="$3"
            textAlign="right"
            keyboardType="decimal-pad"
            value={draft}
            onChangeText={setDraft}
            onBlur={commit}
            onSubmitEditing={commit}
            disabled={locked || plug.pending('price')}
            aria-label="Price per kWh"
            borderColor={valid || draft === '' ? '$borderColor' : '$danger'}
            backgroundColor="$background"
          />
        </XStack>
        <RowSeparator />
        <XStack alignItems="center" justifyContent="space-between" paddingHorizontal="$4" paddingVertical="$3">
          <Text fontSize={13} color="$muted">
            It shows
          </Text>
          <Text fontSize={13} color="$color" fontVariant={['tabular-nums']}>
            {kwh === null ? '—' : `${kwh.toFixed(2)} kWh`}
            {cost === null ? '' : ` · ${cost.toFixed(2)}`}
          </Text>
        </XStack>
        <RowSeparator />
        <ButtonRow
          title="Reset the energy counter"
          subtitle="Sets its energy total and cost back to zero. kraftverk’s own history of it is kept."
          label="Reset"
          icon="rotate-ccw"
          tone="danger"
          disabled={locked}
          onPress={() => plug.press('resetEnergy')}
        />
      </Card>
    </YStack>
  );
}
