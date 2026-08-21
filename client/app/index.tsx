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
  isOnline,
} from '@kraftverk/api-client';
import type { LegacyStationOffer } from '@kraftverk/api-client';

import { Pressable } from '../src/components/Pressable';
import { Screen } from '../src/components/Screen';
import { featherName } from '../src/lib/icons';
import { useDevices } from '../src/state/DevicesProvider';
import { useDirectLink } from '../src/state/DirectLinkProvider';

/**
 * Everything you own, in one list. The app opens here, always.
 *
 * There is nothing station-shaped in this file, and nothing plug-shaped either.
 * A device is a name, an icon, some measurements and some readings; the card
 * renders those, and the screen renders the cards. That is the whole payoff of
 * the device model — adding the plug is a row here, not a feature.
 *
 * Root is the canvas even when you own one device, so the shape of the app does
 * not change as you add the second. The station's dashboard, settings and
 * register tools used to be the top-level tabs; they are now that device's own
 * screens, because a global Dashboard tab is a claim that one device is the
 * whole application.
 */
export default function DevicesScreen() {
  const { devices, editable, loading, error, refresh } = useDevices();
  const { source } = useDirectLink();
  const theme = useTheme();

  const subtitle = editable
    ? devices.length === 0
      ? undefined
      : devices.length === 1
        ? '1 device'
        : `${devices.length} devices`
    : 'This app is holding the link itself';

  return (
    <Screen title="Your devices" subtitle={subtitle}>
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
        <Card gap="$3" alignItems="flex-start">
          <YStack gap="$2">
            <Text fontSize={15} fontWeight="700" color="$color">
              You have not added anything yet
            </Text>
            <Text fontSize={13} color="$muted" lineHeight={19}>
              {source === 'direct'
                ? 'This app is holding the link itself. Connect to a station and it appears here.'
                : 'Add your first device to monitor it, configure it, and later connect it to automations.'}
            </Text>
          </YStack>
          {/*
            Both ways in, because they are different connections rather than a
            main path and a fallback: the server holds a link that outlives the
            app, and this device can hold one directly over Bluetooth while you
            are looking at it. Offering only the first left the second
            undiscoverable once the link screen moved into App settings.
          */}
          <XStack gap="$2" flexWrap="wrap">
            {editable ? (
              <Button
                size="$3"
                backgroundColor="$accent"
                color="$background"
                icon={<Feather name="plus" size={14} color={theme.background?.val} />}
                onPress={() => {
                  haptic();
                  router.push('/add-device');
                }}
              >
                Add a device
              </Button>
            ) : null}
            <Button
              size="$3"
              icon={<Feather name="bluetooth" size={14} color={theme.color?.val} />}
              onPress={() => {
                haptic();
                router.push('/link');
              }}
            >
              {editable ? 'Use one over Bluetooth' : 'Connect a station'}
            </Button>
          </XStack>
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
              color={isOnline(device.health) ? theme.accent?.val : theme.muted?.val}
            />
          }
          onPress={() => router.push(`/device/${encodeURIComponent(device.id)}`)}
        />
      ))}

      {devices.length > 0 || !editable ? (
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
            {/*
              Always reachable, not only from the empty state. A server that
              already holds a station blocks "Power station" in the add flow,
              which used to leave someone who wanted a Bluetooth one with no
              route at all — the two are different connections, not a choice
              you make once.
            */}
            <Pressable onPress={() => router.push('/link')}>
              <Row
                title="Connect over Bluetooth"
                subtitle="Use a station from this device directly, while the app is open"
                accessory={<Feather name="bluetooth" size={16} color={theme.muted?.val} />}
              />
            </Pressable>
            <RowSeparator />
            {/*
              App settings, not device settings. Extensions and the station link
              are infrastructure — how the server reaches things — and they sit
              one level down rather than beside the devices you own.
            */}
            <Pressable onPress={() => router.push('/app-settings')}>
              <Row
                title="App settings"
                subtitle={
                  source === 'direct'
                    ? 'This app is holding a station’s Bluetooth link itself'
                    : 'Extensions, station link and this install'
                }
                accessory={<Feather name="chevron-right" size={16} color={theme.muted?.val} />}
              />
            </Pressable>
          </Card>
        </YStack>
      ) : null}
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

