import { useEffect, useState } from 'react';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import type { DeviceScreenProps } from '@kraftverk/api-client';
import { isPosition, MAIN_PART, type Position, type Reading } from '@kraftverk/device-sdk';
import { Card, Icon, isOld, observedAt, placeOf } from '@kraftverk/ui';

import { Battery, DeviceDrawing, type Kind } from './drawing.tsx';
import { ago, cadence } from './words.ts';

/**
 * A device in Find My, at a glance: where it is — as a place, how sure, and
 * when it was located — when its account looks for it next and how often;
 * what it is, whose, and how charged; and what can be done with it: located
 * now, a sound played. While this page is open its account asks Find My every
 * minute (the app says so to the home), and says so here.
 *
 * Content only: the page frame, the name and the history below are the app's.
 */
export function FindMyDashboard({ device, actions, reach, home }: DeviceScreenProps) {
  const now = useNow(15_000);
  const theme = useTheme();
  const reading = (key: string): Reading | undefined => device.readings.find((each) => each.key === key);
  const value = <T,>(key: string) => (reading(key)?.value ?? null) as T | null;

  if (!device.readings.length) {
    const failed = device.health.status === 'error';
    return (
      <Card alignItems="center" paddingVertical="$8" gap="$4">
        {failed ? null : <Spinner size="large" color="$accent" />}
        <Text color={failed ? '$danger' : '$muted'} fontSize={13} textAlign="center" lineHeight={19} maxWidth={420}>
          {failed ? device.health.detail : reach.waiting}
        </Text>
      </Card>
    );
  }

  const located = reading('position');
  const position = located && isPosition(located.value) ? located.value : null;
  const spec = device.description.attributes.find((attribute) => attribute.key === 'position');
  const stale = spec && located ? isOld(spec, located) : false;
  const charge = value<number>('charge');
  const charging = value<boolean>('charging');
  const owner = value<string>('owner');
  const said = cadence(value<string>('nextLook'), value<number>('lookEvery'), now);
  const model = device.info?.model?.replace(/\s*\(.*\)$/, '') ?? device.meta.name;

  return (
    <YStack gap="$4">
      {device.health.status === 'error' ? (
        <Card borderColor="$danger" borderWidth={1}>
          <Text fontSize={13} color="$danger" lineHeight={19}>
            {device.health.detail}
          </Text>
        </Card>
      ) : null}

      {/* Where — the map comes here (docs/PLAN-MAPS.md) — and when. */}
      <Card gap="$2">
        <Text fontSize={28} fontWeight="800" letterSpacing={-0.5} color={stale ? '$muted' : '$color'} numberOfLines={1}>
          {position ? placeOf(position, home) : 'Not located'}
        </Text>
        {position ? (
          <Text fontSize={13} color="$muted" lineHeight={18}>
            {/* With the home's place, the headline says how far: the coordinates under it. Without, the headline is them: how sure, and how to say how far. */}
            {home ? coordinates(position) : `${typeof position.accuracy === 'number' ? `± ${Math.round(position.accuracy)} m · ` : ''}Say where home is (App settings) to see how far away it is`}
          </Text>
        ) : null}
        <XStack alignItems="center" gap="$2" marginTop="$1">
          <YStack width={8} height={8} borderRadius={4} backgroundColor={!located ? '$muted' : stale ? '$warning' : '$success'} />
          <Text fontSize={14} color="$color" flexShrink={1}>
            {located ? `${stale ? 'Last located' : 'Located'} ${ago(located.at, now)} · ${observedAt(located.at)}` : 'Find My has not said where it is'}
          </Text>
        </XStack>
        {said ? (
          <Text fontSize={12} color="$muted" lineHeight={17}>
            {said}
          </Text>
        ) : null}
      </Card>

      {/* What it is, whose, and how charged. */}
      <Card>
        <XStack alignItems="center" gap="$4">
          <YStack width={100} height={96} alignItems="center" justifyContent="center">
            <DeviceDrawing kind={(value<string>('kind') ?? 'other') as Kind} charging={charging === true} />
          </YStack>
          <YStack flex={1} gap="$1.5" minWidth={0}>
            <Text fontSize={16} fontWeight="700" color="$color" numberOfLines={1}>
              {model}
            </Text>
            <Text fontSize={13} color="$muted" numberOfLines={1}>
              {owner ? `${owner}’s` : 'Yours'}
            </Text>
            <XStack alignItems="center" gap="$2" marginTop="$1">
              <Battery percent={charge} charging={charging} />
              <Text fontSize={16} fontWeight="700" color="$color">
                {charge === null ? '—' : `${charge} %`}
              </Text>
              {charging ? <Icon name="zap" size={16} color={theme.success?.val} /> : null}
            </XStack>
            <Text fontSize={12} color="$muted" numberOfLines={1}>
              {charging === null ? 'Charging not known' : charging ? 'Charging' : 'Not charging'}
              {reading('charge') ? ` · as of ${ago(reading('charge')!.at, now)}` : ''}
            </Text>
          </YStack>
        </XStack>
      </Card>

      <Actions device={device} actions={actions} reachable={reach.now} />
    </YStack>
  );
}

/** "59.62806° N, 17.70450° E · ± 8 m". */
function coordinates(position: Position): string {
  const north = `${Math.abs(position.latitude).toFixed(5)}° ${position.latitude < 0 ? 'S' : 'N'}`;
  const east = `${Math.abs(position.longitude).toFixed(5)}° ${position.longitude < 0 ? 'W' : 'E'}`;
  return `${north}, ${east}${typeof position.accuracy === 'number' ? ` · ± ${Math.round(position.accuracy)} m` : ''}`;
}

/** Located now, and a sound played: what is done from here. Lost mode, which a person confirms, is among its tools. */
function Actions({ device, actions, reachable }: Pick<DeviceScreenProps, 'device' | 'actions'> & { reachable: boolean }) {
  const [busy, setBusy] = useState<'locate' | 'sound' | null>(null);
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null);
  const can = (tool: string) => device.tools.some((each) => each.name === tool);
  const run = async (which: 'locate' | 'sound', work: () => Promise<string>) => {
    setBusy(which);
    setSaid(null);
    try {
      setSaid({ text: await work(), failed: false });
    } catch (error) {
      setSaid({ text: (error as Error).message || 'That did not work', failed: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <YStack gap="$2">
      <XStack gap="$2" flexWrap="wrap">
        {can('locate') ? (
          <Button flex={1} minWidth={140} minHeight={44} backgroundColor="$backgroundPress" icon={busy === 'locate' ? <Spinner size="small" /> : <Icon name="crosshair" size={16} />} disabled={!reachable || busy !== null} opacity={!reachable || busy !== null ? 0.5 : 1} onPress={() => void run('locate', async () => `Located ${ago(String(await actions.tool<string>('locate')), Date.now())}`)}>
            Locate now
          </Button>
        ) : null}
        <Button
          flex={1}
          minWidth={140}
          minHeight={44}
          backgroundColor="$backgroundPress"
          icon={busy === 'sound' ? <Spinner size="small" /> : <Icon name="volume-2" size={16} />}
          disabled={!reachable || busy !== null}
          opacity={!reachable || busy !== null ? 0.5 : 1}
          onPress={() =>
            void run('sound', async () => {
              const result = await actions.command({ part: MAIN_PART, capability: 'identify', command: 'identify', args: {} });
              if (result.outcome === 'refused' || result.outcome === 'failed') throw new Error(result.detail);
              return 'A sound is playing on it';
            })
          }
        >
          Play sound
        </Button>
      </XStack>
      {said ? (
        <Text fontSize={12} color={said.failed ? '$danger' : '$muted'} paddingHorizontal="$1" aria-live="polite">
          {said.text}
        </Text>
      ) : null}
    </YStack>
  );
}

/** A clock that moves: "located 3 min ago" must not stand still while the page is open. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
