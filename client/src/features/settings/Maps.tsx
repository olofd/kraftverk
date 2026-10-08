import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError, PATHS, type MapRegionAsk, type MapRegionsView, type MapRegionView } from '@kraftverk/api-client';
import { isPosition } from '@kraftverk/device-sdk';
import { COUNTRIES, countryAt, overlaps, type Country } from '@kraftverk/map';
import { Card, Icon, Row, RowSeparator, SectionLabel, ToggleRow } from '@kraftverk/ui';

import { ErrorText } from '../../components/ErrorText';
import { Pressable } from '../../components/Pressable';
import { Screen } from '../../components/Screen';
import { confirmAction } from '../../platform/confirm';
import { useDevices } from '../../state/DevicesProvider';
import { useHomePlace } from '../../state/useHomePlace';
import { useServers } from '../../state/ServersProvider';

/**
 * The map the server holds (docs/PLAN-MAPS.md): the world, always; the
 * detail of a country, or of the area around one of your devices, kept on
 * the server — before a journey, say — and detail fetched as you look, kept
 * in a cache. How big a region is is said before it is downloaded.
 */

/** "2.5 GB", "45 MB", "320 kB". */
const sizeOf = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`);

/** What a region is doing, in a line. */
function stateOf(region: MapRegionView): string {
  switch (region.state) {
    case 'ready':
      return `${region.bytes ? sizeOf(region.bytes) : ''}${region.built ? ` · the map of ${region.built}` : ''}`;
    case 'queued':
      return 'Waiting its turn';
    case 'downloading':
      return `Downloading${region.progress ? ` · ${Math.round(region.progress * 100)} %` : '…'}`;
    case 'failed':
      return region.error ?? 'Not downloaded';
  }
}

export function Maps() {
  const { server } = useServers();
  const { devices } = useDevices();
  const home = useHomePlace();
  const theme = useTheme();
  const [view, setView] = useState<MapRegionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!server) return;
    try {
      setView(await server.map.regions());
      setError(null);
    } catch (err) {
      setError(describeError(err) || 'The server did not answer');
    }
  }, [server]);

  // Often while something downloads, so its progress moves; now and then otherwise.
  const downloading = view?.regions.some((region) => region.state === 'downloading' || region.state === 'queued') ?? false;
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), downloading ? 2000 : 15_000);
    return () => clearInterval(timer);
  }, [load, downloading]);

  const act = async (key: string, work: () => Promise<MapRegionsView>) => {
    setBusy(key);
    try {
      setView(await work());
      setError(null);
    } catch (err) {
      setError(describeError(err) || 'That did not work');
    } finally {
      setBusy(null);
    }
  };

  /** A region added: how big it is said first, and asked. */
  const add = (key: string, name: string, ask: MapRegionAsk) =>
    void act(key, async () => {
      const { bytes } = await server!.map.estimate(ask);
      const yes = await confirmAction(`Download the map of ${name}?`, `About ${sizeOf(bytes)}, kept on the server: its streets and places in full detail, with nothing fetched as you look.`, 'Download', 'careful');
      return yes ? server!.map.add(ask) : server!.map.regions();
    });

  const held = view?.regions ?? [];
  const holds = (box: readonly [number, number, number, number]) => held.some((region) => region.kind !== 'world' && region.state !== 'failed' && overlaps(region.box, box));
  const homeCountry = home ? countryAt(home.latitude, home.longitude) : null;
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (term.length < 2) return [];
    return COUNTRIES.filter((country) => country.name.toLowerCase().includes(term)).slice(0, 8);
  }, [search]);
  // Your devices somewhere no region holds: the area around each offered.
  const away = devices.flatMap((device) => {
    const reading = device.readings.find((each) => each.key === 'position');
    if (!reading || !isPosition(reading.value)) return [];
    const { latitude, longitude } = reading.value;
    const box = [longitude - 0.01, latitude - 0.01, longitude + 0.01, latitude + 0.01] as const;
    return holds(box) ? [] : [{ device, latitude, longitude }];
  });

  const countryRow = (country: Country, index: number, note?: string) => (
    <YStack key={country.code}>
      {index > 0 ? <RowSeparator /> : null}
      <Row
        title={country.name}
        subtitle={holds(country.box) ? 'Held' : (note ?? 'Its map, in full detail')}
        accessory={
          holds(country.box) ? (
            <Icon name="check" size={16} color={theme.success?.val} />
          ) : (
            <Button size="$3" minHeight={40} disabled={busy !== null || !view?.downloads.ok} onPress={() => add(country.code, country.name, { country: country.code })}>
              {busy === country.code ? <Spinner size="small" /> : 'Download'}
            </Button>
          )
        }
      />
    </YStack>
  );

  return (
    <Screen back="App settings" backTo={PATHS.settings.index} title="Maps" subtitle="The map your server holds, and where it comes from">
      {error ? <ErrorText paddingHorizontal="$1">{error}</ErrorText> : null}
      {!view && !error ? <Spinner color="$accent" /> : null}

      {view ? (
        <>
          <YStack gap="$2">
            <SectionLabel>What the map holds</SectionLabel>
            <Card inset>
              {held.length === 0 ? <Row title="Nothing kept on the server" subtitle="Every map is fetched as you look." /> : null}
              {held.map((region, index) => (
                <YStack key={region.id}>
                  {index > 0 ? <RowSeparator /> : null}
                  <XStack alignItems="center">
                    <YStack flex={1}>
                      <Row title={region.name} subtitle={region.kind === 'world' ? `Everywhere, roughly · ${stateOf(region)}` : stateOf(region)} />
                    </YStack>
                    {region.state === 'ready' || region.state === 'failed' ? (
                      <Pressable label={`Get ${region.name} afresh`} onPress={() => void act(`refresh-${region.id}`, () => server!.map.refresh(region.id))}>
                        <YStack width={44} height={44} alignItems="center" justifyContent="center">
                          <Icon name="rotate-cw" size={16} color={theme.muted?.val} />
                        </YStack>
                      </Pressable>
                    ) : null}
                    {region.kind !== 'world' ? (
                      <Pressable
                        label={`Remove ${region.name}`}
                        onPress={() =>
                          void (async () => {
                            if (await confirmAction(`Remove the map of ${region.name}?`, 'Its detail is fetched as you look again, if that is on.', 'Remove', 'careful')) await act(`remove-${region.id}`, () => server!.map.remove(region.id));
                          })()
                        }
                      >
                        <YStack width={44} height={44} alignItems="center" justifyContent="center">
                          <Icon name="x" size={16} color={theme.muted?.val} />
                        </YStack>
                      </Pressable>
                    ) : null}
                  </XStack>
                  {region.state === 'downloading' && region.progress !== null ? (
                    <YStack height={4} marginHorizontal="$4" marginBottom="$3" borderRadius={2} backgroundColor="$backgroundPress">
                      <YStack height={4} borderRadius={2} width={`${Math.round(region.progress * 100)}%`} backgroundColor="$accent" />
                    </YStack>
                  ) : null}
                </YStack>
              ))}
            </Card>
            {view.downloads.ok ? null : (
              <Text fontSize={12} color="$muted" paddingHorizontal="$1" lineHeight={17}>
                {view.downloads.reason}
              </Text>
            )}
          </YStack>

          {view.downloads.ok ? (
            <YStack gap="$2">
              <SectionLabel>Download a country</SectionLabel>
              <Card inset>
                {homeCountry ? countryRow(homeCountry, 0, 'Where your home is') : null}
                {homeCountry ? <RowSeparator /> : null}
                <YStack padding="$3">
                  <Input aria-label="A country" placeholder="Another country — before a journey, say" value={search} onChangeText={setSearch} size="$4" autoCapitalize="none" autoCorrect={false} />
                </YStack>
                {matches.map((country, index) => countryRow(country, index + 1))}
              </Card>
            </YStack>
          ) : null}

          {view.downloads.ok && away.length ? (
            <YStack gap="$2">
              <SectionLabel>Where your devices are</SectionLabel>
              <Card inset>
                {away.map(({ device, latitude, longitude }, index) => (
                  <YStack key={device.id}>
                    {index > 0 ? <RowSeparator /> : null}
                    <Row
                      title={`Around ${device.name}`}
                      subtitle="100 km around it, in full detail: not held yet"
                      accessory={
                        <Button size="$3" minHeight={40} disabled={busy !== null} onPress={() => add(`around-${device.id}`, `the area around ${device.name}`, { around: { latitude, longitude, km: 100, name: `Around ${device.name}` } })}>
                          {busy === `around-${device.id}` ? <Spinner size="small" /> : 'Download'}
                        </Button>
                      }
                    />
                  </YStack>
                ))}
              </Card>
            </YStack>
          ) : null}

          <YStack gap="$2">
            <SectionLabel>Detail as you look</SectionLabel>
            <Card inset>
              <ToggleRow
                title="Fetch the detail of what you look at"
                subtitle="Where no region is held, the server fetches what a map shows from Protomaps' build of OpenStreetMap, and keeps it. Protomaps sees which map areas the server asks for, never you."
                checked={view.cache.fetching}
                disabled={busy !== null}
                onCheckedChange={(on) => void act('fetching', () => server!.map.setFetching(on))}
              />
              <RowSeparator />
              <XStack alignItems="center">
                <YStack flex={1}>
                  <Row title="Kept from looking" subtitle={view.cache.bytes ? `${sizeOf(view.cache.bytes)}, 2 GB at most: the least used let go` : 'Nothing yet'} />
                </YStack>
                {view.cache.bytes ? (
                  <Button size="$3" minHeight={40} marginRight="$3" chromeless disabled={busy !== null} onPress={() => void act('clear', () => server!.map.clearCache())}>
                    Let it go
                  </Button>
                ) : null}
              </XStack>
            </Card>
            <Text fontSize={11} color="$muted" paddingHorizontal="$1">
              Map data © OpenStreetMap contributors, cut by Protomaps.
            </Text>
          </YStack>
        </>
      ) : null}
    </Screen>
  );
}
