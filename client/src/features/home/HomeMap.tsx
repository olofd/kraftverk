import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, firstLevel, homeMapOf, mapLevels, outlineFrom, PATHS, placementAt, planWith, type HomeSpaces, type OccupancyView, type SpaceView } from '@kraftverk/api-client';
import type { LngLat } from '@kraftverk/map';
import { Card, Chips, haptic, Icon, MAP_TAKES_TAPS, MapView, Row, RowSeparator, SectionLabel, useMapApi } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { Screen } from '../../components/Screen';
import { confirmAction } from '../../platform/confirm';
import { pickPicture, usePicture } from '../../platform/picture';
import { useDevices } from '../../state/DevicesProvider';
import { useFamily } from '../../state/FamilyProvider';
import { useHomeSpaces } from '../../state/useHomeSpaces';

/*
  A home's map (docs/PLAN-WORLD-MODEL.md §8.5, §8.7, §8.9): a floor at a
  time, its rooms as drawn — filled while someone is in them, from what
  stands there — its drawing beneath, and what stands at coordinates. And
  drawing it: a room traced by tapping its corners, a device placed by
  tapping where it stands, a floor's drawing laid where it belongs. Which
  rooms have someone in them is read again as the home says it moved, and
  every quarter minute besides.
*/

/** How often occupancy is read again, besides when the home says it moved. */
const AGAIN_MS = 15_000;

/** Which rooms have someone in them: the newest answer asked for, never an older one that came later — or why it could not be read. */
function useOccupancy(homeId: string | null): { occupancy: OccupancyView[] | null; failed: boolean } {
  const { api } = useFamily();
  const { onWorld } = useDevices();
  const [occupancy, setOccupancy] = useState<OccupancyView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const asked = useRef(0);
  const load = useCallback(async () => {
    if (!homeId) return;
    const ask = ++asked.current;
    try {
      const answer = await api.occupancy.now(homeId);
      if (ask !== asked.current) return;
      setOccupancy(answer);
      setFailed(false);
    } catch {
      // Kept as it was, and said: the next look tries again.
      if (ask === asked.current) setFailed(true);
    }
  }, [api, homeId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), AGAIN_MS);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => onWorld((what, at) => (what === 'occupancy' && (at === null || at === homeId) ? void load() : undefined)), [onWorld, load, homeId]);
  return { occupancy, failed };
}

/** What a tap on the map does now. */
type Tapping = { kind: 'look' } | { kind: 'trace'; spaceId: string; corners: LngLat[] } | { kind: 'place'; deviceId: string } | { kind: 'corner' };

const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function HomeMapScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { homes } = useHomeSpaces();
  const here = homes?.find((each) => each.home.id === id) ?? homes?.[0] ?? null;
  return (
    <Screen back="Your devices" backTo={PATHS.home} title={here ? `${here.home.name}, room by room` : 'The home’s map'} subtitle="Which rooms have someone in them, and what stands where">
      {!homes ? <Spinner color="$accent" /> : here ? <HomeMap key={here.home.id} here={here} homes={homes} /> : <Text color="$muted">This family has no home yet.</Text>}
    </Screen>
  );
}

function HomeMap({ here, homes }: { here: HomeSpaces; homes: HomeSpaces[] }) {
  const { api } = useFamily();
  const { reload } = useHomeSpaces();
  const { devices, refresh } = useDevices();
  const mapApi = useMapApi();
  const theme = useTheme();
  const { home, spaces } = here;
  const levels = mapLevels(spaces);
  // The level it opens on, kept: clearing what is drawn on it does not move the map to another.
  const [levelId, setLevelId] = useState<string | null>(() => firstLevel(spaces)?.id ?? null);
  const level = levels.find((each) => each.id === levelId) ?? firstLevel(spaces);
  const { occupancy, failed: occupancyFailed } = useOccupancy(home.id);
  // Drawing on the map needs a map that takes taps: not a phone's, yet.
  const draws = Boolean(mapApi) && MAP_TAKES_TAPS;
  const [tapping, setTapping] = useState<Tapping>({ kind: 'look' });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const map = useMemo(() => (level ? homeMapOf({ home, spaces, devices, occupancy: occupancy ?? [], showing: level.id }) : null), [home, spaces, devices, occupancy, level]);
  const drawingUrl = usePicture(api, map?.drawing?.pictureId ?? null);
  const corners = map?.drawing?.corners;
  const drawing = useMemo(() => (corners && drawingUrl ? { url: drawingUrl, corners } : null), [drawingUrl, corners ? JSON.stringify(corners) : null]);
  // Before anything is drawn, the map looks at the home: a few rooms' worth around it.
  const centre = useMemo(() => (map?.anchor ? { latitude: map.anchor.latitude, longitude: map.anchor.longitude, metres: 20 } : null), [map?.anchor?.latitude, map?.anchor?.longitude]);

  const doing = async (work: () => Promise<unknown>, failed: string) => {
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      await work();
      await reload();
    } catch (err) {
      setProblem(describeError(err) || failed);
    } finally {
      setBusy(false);
    }
  };

  if (!level || !map) return <Text color="$muted">{home.name} has no spaces yet: add its floors and rooms on its page.</Text>;
  const anchor = map.anchor;
  const spaceName = (spaceId: string) => spaces.find((space) => space.id === spaceId)?.name ?? 'the room';
  const onLevel = devices.filter((device) => device.placement && map.drawn.concat(map.undrawn, [level]).some((space) => space.id === device.placement!.spaceId));

  const tap = (place: { latitude: number; longitude: number }) => {
    if (!anchor) return;
    const at: LngLat = [place.longitude, place.latitude];
    if (tapping.kind === 'trace') return setTapping({ ...tapping, corners: [...tapping.corners, at] });
    if (tapping.kind === 'place') {
      const device = devices.find((each) => each.id === tapping.deviceId);
      const spot = placementAt(anchor, spaces, level.id, device?.placement?.spaceId ?? null, at);
      setTapping({ kind: 'look' });
      return void doing(async () => {
        await api.devices.place(tapping.deviceId as never, { spaceId: spot.spaceId, x: spot.x, y: spot.y, ...(device?.placement?.spaceId === spot.spaceId ? { openingId: device.placement.openingId, z: device.placement.z, facing: device.placement.facing } : {}) });
        await refresh();
      }, 'It could not be placed');
    }
    if (tapping.kind === 'corner' && level.plan) {
      const [x, y] = outlineFrom(anchor, spaces, level.id, [at])[0]!;
      setTapping({ kind: 'look' });
      return void doing(() => api.spaces.update(level.id, { plan: { pictureId: level.plan!.pictureId, scale: level.plan!.scale, x, y, turn: level.plan!.turn } }), 'The drawing could not be moved');
    }
  };

  const saveOutline = (spaceId: string, corners: LngLat[]) => {
    if (!anchor) return;
    setTapping({ kind: 'look' });
    void doing(() => api.spaces.update(spaceId, { outline: outlineFrom(anchor, spaces, spaceId, corners) }), 'The outline could not be kept');
  };

  const addDrawing = () =>
    doing(async () => {
      const picked = await pickPicture();
      if (!picked) return;
      const picture = await api.media.add(picked);
      await api.spaces.update(level.id, { plan: planWith(level.plan, { id: picture.id, width: picked.width }) });
    }, 'The drawing could not be added');

  const clearOutlines = async () => {
    const many = map.drawn.length === 1 ? 'its outline' : `the ${map.drawn.length} outlines`;
    if (!(await confirmAction(`Clear ${many} on ${level.name}?`, 'Each room traced on this floor is traced again to be shown.', 'Clear', 'dangerous'))) return;
    await doing(() => Promise.all(map.drawn.map((space) => api.spaces.update(space.id, { outline: null }))), 'The outlines could not be cleared');
  };

  const hint =
    tapping.kind === 'trace'
      ? `Tap each corner of ${spaceName(tapping.spaceId)} in turn — ${tapping.corners.length} so far`
      : tapping.kind === 'place'
        ? `Tap where ${devices.find((each) => each.id === tapping.deviceId)?.name ?? 'it'} stands`
        : tapping.kind === 'corner'
          ? 'Tap where the drawing’s top-left corner belongs'
          : null;

  return (
    <YStack gap="$4">
      {homes.length > 1 ? <Chips label="Home" options={homes.map((each) => ({ value: each.home.id, label: each.home.name }))} value={home.id} onChange={(next) => router.replace(PATHS.rooms(next))} /> : null}
      {levels.length > 1 ? (
        <Chips
          label="Floor"
          options={levels.map((each) => ({ value: each.id, label: each.name }))}
          value={level.id}
          onChange={(next) => {
            setTapping({ kind: 'look' });
            setLevelId(next);
          }}
        />
      ) : null}
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}

      {!anchor ? (
        <Card>
          <Text fontSize={14} color="$color" lineHeight={20}>
            Say where {home.name} is first: its rooms are drawn in metres from there.
          </Text>
          <Button size="$3" marginTop="$3" onPress={() => router.push(PATHS.settings.home(home.id))}>
            {`${home.name}’s page`}
          </Button>
        </Card>
      ) : mapApi ? (
        <YStack gap="$2">
          <MapView
            label={`${home.name}: ${level.name}, its rooms — ${map.occupied.length ? `someone in ${map.occupied.map((room) => room.name).join(', ')}` : 'nobody in any'}`}
            height={360}
            areas={map.areas}
            markers={map.markers}
            drawing={drawing}
            tracing={tapping.kind === 'trace' ? tapping.corners : null}
            centre={centre}
            view={level.id}
            onPress={tapping.kind === 'look' ? undefined : tap}
          />
          {hint ? (
            <XStack gap="$2" alignItems="center" flexWrap="wrap">
              <Text flex={1} minWidth={200} fontSize={13} color="$accent">
                {hint}
              </Text>
              {tapping.kind === 'trace' ? (
                <>
                  <Button size="$3" minHeight={44} disabled={!tapping.corners.length} onPress={() => setTapping({ ...tapping, corners: tapping.corners.slice(0, -1) })}>
                    Undo
                  </Button>
                  <Button size="$3" minHeight={44} backgroundColor="$accent" color="$background" disabled={tapping.corners.length < 3 || busy} onPress={() => saveOutline(tapping.spaceId, tapping.corners)}>
                    Keep it
                  </Button>
                </>
              ) : null}
              <Button size="$3" minHeight={44} chromeless onPress={() => setTapping({ kind: 'look' })}>
                Cancel
              </Button>
            </XStack>
          ) : null}
        </YStack>
      ) : (
        <Text color="$muted">A map is drawn by a server: this app has none.</Text>
      )}

      <YStack gap="$2" role="region" aria-label="Someone is in">
        <SectionLabel>Someone is in</SectionLabel>
        <Card inset>
          {!occupancy ? (
            <Row title={occupancyFailed ? 'Who is in which room could not be read' : 'Looking…'} subtitle={occupancyFailed ? 'It is asked again in a moment' : undefined} />
          ) : map.occupied.length ? (
            map.occupied.map((room, index) => (
              <YStack key={room.spaceId}>
                {index ? <RowSeparator /> : null}
                <Row
                  leading={<YStack width={12} height={12} borderRadius={6} backgroundColor="$accent" />}
                  title={room.peak ? `${room.name} · ${room.peak} there` : room.name}
                  subtitle={`Since ${clock(room.since)}, said by ${room.by.join(', ') || 'who is there'}`}
                />
              </YStack>
            ))
          ) : (
            <Row title="Nobody, that anything here can tell" subtitle="Motion sensors, presence radars and door contacts placed in a room say who is in it" />
          )}
        </Card>
      </YStack>

      {anchor && draws ? (
        <YStack gap="$2">
          <SectionLabel>Draw it</SectionLabel>
          <Card gap="$3">
            <Text fontSize={13} color="$muted" lineHeight={18}>
              Trace a room by tapping its corners on the map, in turn: over its floor’s drawing, or over the street map. A room drawn shows whether someone is in it.
            </Text>
            {map.drawn.length + map.undrawn.length ? (
              <Chips
                label="Trace a room"
                options={[...map.undrawn, ...map.drawn].map((space: SpaceView) => ({ value: space.id, label: space.outline ? `${space.name} again` : space.name }))}
                value={tapping.kind === 'trace' ? tapping.spaceId : null}
                onChange={(spaceId) => setTapping({ kind: 'trace', spaceId, corners: [] })}
              />
            ) : (
              <Text fontSize={13} color="$muted">
                {level.name} has no rooms yet: add them on {home.name}’s page.
              </Text>
            )}
            {onLevel.length ? (
              <>
                <Text fontSize={13} color="$muted" lineHeight={18}>
                  Place what stands here where it stands: a sensor where it looks from, a lamp where it lights.
                </Text>
                <Chips label="Place a device" options={onLevel.map((device) => ({ value: device.id as string, label: device.name }))} value={tapping.kind === 'place' ? tapping.deviceId : null} onChange={(deviceId) => setTapping({ kind: 'place', deviceId })} />
              </>
            ) : null}
            {map.drawn.length ? (
              <Button size="$3" minHeight={44} chromeless color="$muted" disabled={busy} onPress={() => void clearOutlines()}>
                {`Clear the ${map.drawn.length === 1 ? 'outline' : `${map.drawn.length} outlines`} on ${level.name}`}
              </Button>
            ) : null}
          </Card>
        </YStack>
      ) : null}

      {anchor && draws && level.kind === 'floor' ? <Drawing level={level} busy={busy} onAdd={() => void addDrawing()} onCorner={() => setTapping({ kind: 'corner' })} doing={doing} /> : null}

      <Pressable onPress={() => router.push(PATHS.settings.home(home.id))}>
        <Row title={`${home.name}’s floors and rooms`} subtitle="Add, rename and move them; doors between them" accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />} />
      </Pressable>
    </YStack>
  );
}

/** A floor's drawing: added, laid where it belongs, sized and turned. */
function Drawing({ level, busy, onAdd, onCorner, doing }: { level: SpaceView; busy: boolean; onAdd: () => void; onCorner: () => void; doing: (work: () => Promise<unknown>, failed: string) => Promise<void> }) {
  const { api } = useFamily();
  const plan = level.plan;
  const [across, setAcross] = useState(plan ? String(Math.round(plan.scale * plan.width * 100) / 100) : '');
  const [turn, setTurn] = useState(plan ? String(plan.turn) : '0');
  useEffect(() => {
    setAcross(plan ? String(Math.round(plan.scale * plan.width * 100) / 100) : '');
    setTurn(plan ? String(plan.turn) : '0');
  }, [plan?.pictureId, plan?.scale, plan?.turn]);
  const takeAway = async () => {
    if (!(await confirmAction(`Take ${level.name}’s drawing away?`, 'The rooms traced over it stay.', 'Take it away', 'dangerous'))) return;
    await doing(() => api.spaces.update(level.id, { plan: null }), 'The drawing could not be taken away');
  };
  const metres = Number(across.replace(',', '.'));
  const degrees = Number(turn.replace(',', '.'));
  const fine = plan && metres > 0 && Number.isFinite(degrees);
  return (
    <YStack gap="$2">
      <SectionLabel>{`${level.name}’s drawing`}</SectionLabel>
      <Card gap="$3">
        <Text fontSize={13} color="$muted" lineHeight={18}>
          A plan of the floor — a photo of a drawing, an estate agent’s — laid on the map to trace its rooms over. Say how many metres it is across, then tap where its top-left corner belongs.
        </Text>
        <XStack gap="$2" flexWrap="wrap">
          <Button size="$3" minHeight={44} disabled={busy} onPress={onAdd}>
            {plan ? 'Another drawing' : 'Add a drawing'}
          </Button>
          {plan ? (
            <>
              <Button size="$3" minHeight={44} disabled={busy} onPress={onCorner}>
                Place its corner
              </Button>
              <Button size="$3" minHeight={44} chromeless color="$muted" disabled={busy} onPress={() => void takeAway()}>
                Take it away
              </Button>
            </>
          ) : null}
        </XStack>
        {plan ? (
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Input flex={1} minWidth={120} aria-label="Metres across" placeholder="Metres across" size="$4" inputMode="decimal" value={across} onChangeText={setAcross} />
            <Input flex={1} minWidth={120} aria-label="Turned, in degrees" placeholder="Turned, degrees" size="$4" inputMode="decimal" value={turn} onChangeText={setTurn} />
            <Button
              size="$3"
              minHeight={44}
              backgroundColor="$accent"
              color="$background"
              disabled={!fine || busy}
              onPress={() => void doing(() => api.spaces.update(level.id, { plan: { pictureId: plan.pictureId, scale: metres / plan.width, x: plan.x, y: plan.y, turn: ((degrees % 360) + 360) % 360 } }), 'The drawing could not be changed')}
            >
              Keep
            </Button>
          </XStack>
        ) : null}
      </Card>
    </YStack>
  );
}
