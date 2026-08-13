import { useCallback, useEffect, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, DeviceCard, Row, RowSeparator, SectionLabel, haptic } from '@kraftverk/ui';
import {
  describeError,
  dismissStationImport,
  fetchStationImport,
  importLegacyStation,
} from '@kraftverk/api-client';
import type { DeviceView, LegacyStationOffer } from '@kraftverk/api-client';

import { Screen } from '../../src/components/Screen';
import { featherName } from '../../src/lib/icons';
import { useDevices } from '../../src/state/DevicesProvider';
import { useStation } from '../../src/state/StationProvider';

/**
 * Everything you own, in one list.
 *
 * There is nothing station-shaped in this file, and nothing plug-shaped either.
 * A device is a name, an icon, some measurements and some readings; the card
 * renders those, and the screen renders the cards. That is the whole payoff of
 * the device model — adding the plug is a row here, not a feature.
 */
export default function DevicesScreen() {
  const { devices, station, editable, loading, error, refresh } = useDevices();
  const { source } = useStation();
  const theme = useTheme();

  const subtitle = editable
    ? devices.length === 1
      ? '1 device'
      : `${devices.length} devices`
    : 'This app is holding the link itself';

  return (
    <Screen title="Devices" subtitle={subtitle}>
      {editable ? <LegacyStationBanner onImported={refresh} /> : null}

      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger" lineHeight={19}>
            {error}
          </Text>
        </Card>
      ) : null}

      {loading && devices.length === 0 ? (
        <Card>
          <YStack padding="$5" alignItems="center">
            <Spinner color="$accent" />
          </YStack>
        </Card>
      ) : null}

      {!loading && devices.length === 0 ? (
        <Card gap="$2">
          <Text fontSize={15} fontWeight="700" color="$color">
            Nothing added yet
          </Text>
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {source === 'direct'
              ? 'Connect to a station from the link screen and it will appear here.'
              : 'Add your power station, then anything else a driver can reach.'}
          </Text>
        </Card>
      ) : null}

      {devices.map((device) => (
        <DeviceCard
          key={device.id}
          device={device}
          icon={
            <Feather
              name={featherName(device.icon, 'zap')}
              size={16}
              color={device.online ? theme.accent?.val : theme.muted?.val}
            />
          }
          onPress={() => router.push(`/device/${encodeURIComponent(device.id)}`)}
        />
      ))}

      <YStack gap="$2">
        <SectionLabel>Manage</SectionLabel>
        <Card inset>
          {editable ? (
            <>
              <Pressable onPress={() => router.push('/add-device')}>
                <Row
                  title="Add a device"
                  subtitle="A power station, or anything an installed extension can reach"
                  accessory={<Feather name="plus" size={16} color={theme.muted?.val} />}
                />
              </Pressable>
              <RowSeparator />
            </>
          ) : null}
          <Pressable onPress={() => router.push('/link')}>
            <Row
              title="Station link"
              subtitle={linkSubtitle(source, station)}
              accessory={<Feather name="chevron-right" size={16} color={theme.muted?.val} />}
            />
          </Pressable>
        </Card>
      </YStack>
    </Screen>
  );
}

/**
 * The station you bound before there was a device catalog.
 *
 * The server used to adopt it at startup. It no longer does — a device exists
 * because you added it — so the one case that would otherwise lose something is
 * offered here instead: a previous installation's binding, imported once, by
 * you. Dismissing it is permanent, and the station can still be added by hand.
 */
function LegacyStationBanner({ onImported }: { onImported: () => Promise<void> }) {
  const [offer, setOffer] = useState<LegacyStationOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchStationImport(controller.signal)
      .then(setOffer)
      .catch(() => undefined); // an older server has no such route, and that is fine
    return () => controller.abort();
  }, []);

  const act = useCallback(
    async (work: () => Promise<unknown>) => {
      haptic();
      setBusy(true);
      setError(null);
      try {
        await work();
        setOffer(null);
        await onImported();
      } catch (err: unknown) {
        setError(describeError(err) || 'That did not work');
      } finally {
        setBusy(false);
      }
    },
    [onImported]
  );

  if (offer?.state !== 'offered') return null;

  const where =
    offer.transport === 'ble'
      ? 'over Bluetooth'
      : offer.transport === 'mqtt'
        ? 'over WiFi'
        : '';

  return (
    <Card gap="$3" borderColor="$accent">
      <YStack gap="$2">
        <Text fontSize={15} fontWeight="700" color="$color">
          A station from a previous version
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          This server is bound {where} to {offer.boundId}, from before devices were something
          you added. Add it to your list to keep its name, settings and history in one place.
        </Text>
        {error ? (
          <Text fontSize={13} color="$danger" lineHeight={19}>
            {error}
          </Text>
        ) : null}
      </YStack>
      <XStack gap="$2">
        <Button
          size="$3"
          backgroundColor="$accent"
          color="$background"
          disabled={busy}
          onPress={() => void act(() => importLegacyStation(offer.name ?? undefined))}
        >
          Add it as a device
        </Button>
        <Button size="$3" disabled={busy} onPress={() => void act(dismissStationImport)}>
          Dismiss
        </Button>
        {busy ? <Spinner size="small" color="$accent" /> : null}
      </XStack>
    </Card>
  );
}

/** What the link row says under it: how we reach the station, in one line. */
function linkSubtitle(source: 'server' | 'direct', station: DeviceView | null): string {
  if (source === 'direct') return 'This app holds the station’s Bluetooth connection';
  if (!station) return 'How the server reaches your power station';
  const transport = station.record.config.transport;
  return transport === 'ble'
    ? 'The server holds it over Bluetooth'
    : transport === 'mqtt'
      ? 'The server holds it over WiFi'
      : 'Running against the simulator';
}

/** Tamagui's press styling on a plain wrapper, so a Row can be tapped. */
function Pressable({ onPress, children }: { onPress: () => void; children: React.ReactNode }) {
  return (
    <XStack pressStyle={{ opacity: 0.6 }} onPress={onPress}>
      <YStack flex={1}>{children}</YStack>
    </XStack>
  );
}
