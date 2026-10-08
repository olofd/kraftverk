import { useEffect, useState } from 'react';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import type { DeviceScreenProps, DeviceTrack, TrackPointView } from '@kraftverk/api-client';
import { isPosition, MAIN_PART, type Position, type Reading } from '@kraftverk/device-sdk';
import { Card, Chips, daysText, Icon, isOld, MapView, observedAt, placeOf, TrackSetting } from '@kraftverk/ui';

import { Battery, DeviceDrawing, type Kind } from './drawing.tsx';
import { ago, cadence } from './words.ts';

/**
 * A device in Find My, at a glance: where it is — as a place, how sure, and
 * when it was located — when its account looks for it next and how often;
 * what it is, whose, and how charged; and what can be done with it: located
 * now, a sound played. While this page is open its account asks Find My every
 * minute (the app says so to the home), and says so here. Where it has been
 * is drawn as a trail while its owner keeps it, and keeping it is turned on
 * and off here as well as in its settings.
 *
 * Content only: the page frame, the name and the history below are the app's.
 */
export function FindMyDashboard({ device, actions, reach, home, track }: DeviceScreenProps) {
  const now = useNow(15_000);
  const theme = useTheme();
  const reading = (key: string): Reading | undefined => device.readings.find((each) => each.key === key);
  const value = <T,>(key: string) => (reading(key)?.value ?? null) as T | null;
  const [span, setSpan] = useState(1);
  const trail = useTrail(track, device.trackDays, span, reading('position')?.at);

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
  // The trail, to where it is now.
  const line = position && located && (!trail.length || trail[trail.length - 1]!.at < located.at) ? [...trail, { latitude: position.latitude, longitude: position.longitude }] : trail;
  const spans = device.trackDays ? spansFor(device.trackDays) : [];

  return (
    <YStack gap="$4">
      {device.health.status === 'error' ? (
        <Card borderColor="$danger" borderWidth={1}>
          <Text fontSize={13} color="$danger" lineHeight={19}>
            {device.health.detail}
          </Text>
        </Card>
      ) : null}

      {/* Where — on the map, followed as it moves — and when. */}
      <Card gap="$2">
        {position ? (
          <YStack marginBottom="$2">
            <MapView
              label={`Where ${device.name} is`}
              markers={[{ id: device.id, latitude: position.latitude, longitude: position.longitude, accuracy: position.accuracy ?? null, stale }]}
              trails={line.length > 1 ? [{ id: 'trail', points: line }] : []}
              zones={home ? [{ id: 'home', latitude: home.latitude, longitude: home.longitude, radius: 150, label: 'Home' }] : []}
              follow={device.id}
              height={260}
            />
          </YStack>
        ) : null}
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
        {device.trackDays ? (
          <YStack gap="$2" marginTop="$2">
            {spans.length > 1 ? <Chips label="How far back the trail goes" options={spans} value={Math.min(span, device.trackDays)} onChange={setSpan} /> : null}
            <Text fontSize={12} color="$muted" lineHeight={17}>
              {trail.length ? `The trail: ${trail.length === 1 ? '1 place' : `${trail.length} places`} since ${observedAt(trail[0]!.at)}` : 'Nothing kept yet: its trail starts as it is located.'}
            </Text>
          </YStack>
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

      <Keeping days={device.trackDays} track={track} />
    </YStack>
  );
}

/** How far back a trail is drawn, as offered: never further than it is kept. */
function spansFor(days: number): { value: number; label: string }[] {
  const shorter = [1, 7, 30].filter((each) => each < days).map((each) => ({ value: each, label: each === 1 ? 'Today' : daysText(each) }));
  return [...shorter, { value: days, label: shorter.length ? 'All kept' : 'Today' }];
}

/** Where it has been since `days` ago, read again as it is located again; nothing while it is not kept. */
function useTrail(track: DeviceTrack, days: number | null, span: number, latest: string | undefined): TrackPointView[] {
  const [points, setPoints] = useState<TrackPointView[]>([]);
  useEffect(() => {
    if (days === null) {
      setPoints([]);
      return;
    }
    let current = true;
    const since = new Date(Date.now() - Math.min(span, days) * 86_400_000).toISOString();
    track
      .since(since)
      .then((got) => current && setPoints(got))
      .catch(() => current && setPoints([]));
    return () => {
      current = false;
    };
    // `track` is made afresh with every list the app reads; what it reads is the device's, which these say.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, span, latest]);
  return points;
}

/** Keeping where it has been: on, off — which forgets it, once its owner says so — and for how long. */
function Keeping({ days, track }: { days: number | null; track: DeviceTrack }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const keep = (next: number | null) => {
    setBusy(true);
    setFailed(null);
    track
      .keep(next)
      .catch((error: unknown) => setFailed((error as Error).message || 'That could not be changed'))
      .finally(() => setBusy(false));
  };
  return (
    <YStack gap="$2">
      <Card inset>
        <TrackSetting days={days} disabled={busy} onChange={keep} />
      </Card>
      {failed ? (
        <Text fontSize={12} color="$danger" paddingHorizontal="$1">
          {failed}
        </Text>
      ) : null}
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
