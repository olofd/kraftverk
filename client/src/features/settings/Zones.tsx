import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, PATHS, type HomeView, type ZoneInput, type ZoneView } from '@kraftverk/api-client';
import { Card, formatCoordinates, haptic, Icon, MapView, Row, RowSeparator, SectionLabel, useMapApi } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { Screen } from '../../components/Screen';
import { confirmAction } from '../../platform/confirm';
import { useFamily } from '../../state/FamilyProvider';

/*
  The family's zones (docs/PLAN-WORLD-MODEL.md §8.4): the places it knows
  that are no home — school, work, the gym — each a circle on the map,
  where presence says someone is. Typed in degrees, as a map gives them;
  let go, a zone is archived and the stays there stay its own.
*/

/** How big a zone is when nobody said: a school, a workplace. */
const SIZE = 200;

/** A number typed as a person types it — "59,33" too — within ± `most`; null when it is not one. */
const number = (typed: string, most: number): number | null => {
  const value = Number(typed.trim().replace(',', '.'));
  return typed.trim() !== '' && Number.isFinite(value) && Math.abs(value) <= most ? value : null;
};

/** A zone in a line: where it is, and how big. */
const zoneLine = (zone: ZoneView): string => `${formatCoordinates(zone.location)} · ${Math.round(zone.location.radius)} m across its middle`;

/** The zones and homes on one map, each a circle; none drawn where no server serves the map. */
function PlacesMap({ zones, homes, label }: { zones: readonly ZoneView[]; homes: readonly HomeView[]; label: string }) {
  const mapApi = useMapApi();
  if (!mapApi || (!zones.length && !homes.some((home) => home.location))) return null;
  return (
    <MapView
      label={label}
      height={240}
      zones={[
        ...homes.flatMap((home) => (home.location ? [{ id: home.id, ...home.location, label: home.name }] : [])),
        ...zones.map((zone) => ({ id: zone.id, ...zone.location, label: zone.name, color: '#8b5cf6' })),
      ]}
    />
  );
}

/** Where a zone is, and how big: what the form edits. */
function ZoneFields({ zone, busy, submit, onSubmit }: { zone: ZoneView | null; busy: boolean; submit: string; onSubmit: (input: ZoneInput) => void }) {
  const [name, setName] = useState(zone?.name ?? '');
  const [latitude, setLatitude] = useState(zone ? String(zone.location.latitude) : '');
  const [longitude, setLongitude] = useState(zone ? String(zone.location.longitude) : '');
  const [size, setSize] = useState(String(zone?.location.radius ?? SIZE));
  const typed = { latitude: number(latitude, 90), longitude: number(longitude, 180), radius: number(size, 50_000) };
  const ready = name.trim() && typed.latitude !== null && typed.longitude !== null && typed.radius !== null && typed.radius >= 10;
  return (
    <Card gap="$3">
      <Input aria-label="Its name" placeholder="Its name: School" size="$4" maxLength={60} value={name} onChangeText={setName} />
      <XStack gap="$2">
        <Input flex={1} aria-label="Latitude" placeholder="Latitude: 59.3293" size="$4" inputMode="decimal" value={latitude} onChangeText={setLatitude} />
        <Input flex={1} aria-label="Longitude" placeholder="Longitude: 18.0686" size="$4" inputMode="decimal" value={longitude} onChangeText={setLongitude} />
      </XStack>
      <XStack gap="$2" alignItems="center">
        <Input width={110} aria-label="How far across its middle, in metres" size="$4" inputMode="numeric" value={size} onChangeText={setSize} />
        <Text fontSize={13} color="$muted" flex={1} lineHeight={18}>
          metres from its middle to its edge: where someone is in it
        </Text>
      </XStack>
      <XStack>
        <Button
          size="$3"
          minHeight={44}
          backgroundColor="$accent"
          color="$background"
          disabled={!ready || busy}
          opacity={ready && !busy ? 1 : 0.5}
          onPress={() => ready && onSubmit({ name: name.trim(), location: { latitude: typed.latitude!, longitude: typed.longitude!, radius: typed.radius! } })}
        >
          {busy ? <Spinner size="small" /> : submit}
        </Button>
      </XStack>
    </Card>
  );
}

export function Zones() {
  const { api } = useFamily();
  const theme = useTheme();
  const [zones, setZones] = useState<ZoneView[] | null>(null);
  const [homes, setHomes] = useState<HomeView[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState(0);

  const load = useCallback(async () => {
    try {
      const [all, theirHomes] = await Promise.all([api.zones.list(), api.homes.list()]);
      setZones(all);
      setHomes(theirHomes);
      setProblem(null);
    } catch (err) {
      setProblem(describeError(err) || 'The zones could not be read');
    }
  }, [api]);
  useEffect(() => void load(), [load]);

  const add = async (input: ZoneInput) => {
    haptic();
    setAdding(true);
    setProblem(null);
    try {
      await api.zones.add(input);
      // A fresh form for the next one.
      setKey((n) => n + 1);
      await load();
    } catch (err) {
      setProblem(describeError(err) || 'It could not be added');
    } finally {
      setAdding(false);
    }
  };

  const chevron = <Icon name="chevron-right" size={16} color={theme.muted?.val} />;
  return (
    <Screen back="App settings" backTo={PATHS.settings.index} title="Zones" subtitle="Places your family knows that are no home: school, work — where it is said someone is">
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
      {!zones && !problem ? <Spinner color="$accent" /> : null}
      {zones ? <PlacesMap zones={zones} homes={homes} label="Your family's homes and zones" /> : null}
      {zones?.length ? (
        <YStack gap="$2">
          <SectionLabel>Your zones</SectionLabel>
          <Card inset>
            {zones.map((zone, index) => (
              <YStack key={zone.id}>
                {index > 0 ? <RowSeparator /> : null}
                <Pressable onPress={() => router.push(PATHS.settings.zone(zone.id))}>
                  <Row title={zone.name} subtitle={zoneLine(zone)} accessory={chevron} />
                </Pressable>
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}
      <YStack gap="$2">
        <SectionLabel>Add a zone</SectionLabel>
        <ZoneFields key={key} zone={null} busy={adding} submit="Add it" onSubmit={(input) => void add(input)} />
      </YStack>
    </Screen>
  );
}

/** One zone: its name, where it is and how big — changed here, or let go. */
export function ZonePage() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useFamily();
  const [zone, setZone] = useState<ZoneView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.zones
      .list({ removed: true })
      .then((all) => {
        const found = all.find((each) => each.id === id) ?? null;
        setZone(found);
        setProblem(found ? null : 'There is no such zone');
      })
      .catch((err: unknown) => setProblem(describeError(err) || 'The zone could not be read'));
  }, [api, id]);

  const save = async (input: ZoneInput) => {
    if (!zone) return;
    haptic();
    setBusy(true);
    setProblem(null);
    try {
      setZone(await api.zones.update(zone.id, input));
    } catch (err) {
      setProblem(describeError(err) || 'It could not be changed');
    } finally {
      setBusy(false);
    }
  };
  const letGo = async () => {
    if (!zone) return;
    if (!(await confirmAction(`Let go of ${zone.name}?`, 'It goes from your zones. Who was there, and when, is kept as it was.', 'Let it go', 'careful'))) return;
    try {
      await api.zones.remove(zone.id);
      router.replace(PATHS.settings.zones);
    } catch (err) {
      setProblem(describeError(err) || 'It could not be let go');
    }
  };

  return (
    <Screen back="Zones" backTo={PATHS.settings.zones} title={zone?.name ?? 'A zone'} subtitle={zone ? zoneLine(zone) : undefined}>
      {problem ? <ErrorText paddingHorizontal="$1">{problem}</ErrorText> : null}
      {!zone && !problem ? <Spinner color="$accent" /> : null}
      {zone ? (
        <>
          <PlacesMap zones={[zone]} homes={[]} label={`Where ${zone.name} is`} />
          {zone.removedAt ? (
            <Card>
              <Text fontSize={13} color="$muted" lineHeight={19}>
                Let go of {zone.removedAt.slice(0, 10)}: kept for who was there, and when.
              </Text>
            </Card>
          ) : (
            <>
              <YStack gap="$2">
                <SectionLabel>What it is, and where</SectionLabel>
                <ZoneFields key={zone.id} zone={zone} busy={busy} submit="Save" onSubmit={(input) => void save(input)} />
              </YStack>
              <XStack>
                <Button size="$3" minHeight={44} chromeless color="$danger" onPress={() => void letGo()}>
                  Let it go
                </Button>
              </XStack>
            </>
          )}
        </>
      ) : null}
    </Screen>
  );
}
