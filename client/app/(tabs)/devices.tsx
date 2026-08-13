import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, SectionLabel } from '@kraftverk/ui';
import { Row, RowSeparator, ToggleRow } from '@kraftverk/ui';
import { Screen } from '../../src/components/Screen';
import { SegmentedControl } from '@kraftverk/ui';
import { bindDevice, describeError, fetchDevices, unbindDevice } from '@kraftverk/api-client';
import { formatAgo } from '@kraftverk/ui';
import { haptic } from '@kraftverk/ui';
import type { DeviceList } from '@kraftverk/api-client';
import { useStation, type LinkSource } from '../../src/state/StationProvider';

/**
 * How the app reaches the station, and which station.
 *
 * There are two ways in. The server can hold the link — over its embedded MQTT
 * broker or its own Bluetooth adapter — and the app talks HTTP to it; or the
 * app can hold the Bluetooth link itself, with no server involved at all.
 * Both decode with the same protocol package, so nothing below this choice
 * changes: the same registers, the same write whitelist, the same numbers.
 *
 * Only one of them can be connected at a time. These stations accept a single
 * Bluetooth connection, so a phone holding it locks out the server, and the
 * vendor app locks out both.
 */
const SOURCES = [
  { value: 'server', label: 'Server' },
  { value: 'direct', label: 'This device' },
] as const satisfies readonly { value: LinkSource; label: string }[];

export default function DevicesScreen() {
  const { status, refresh, source, setSource, direct } = useStation();

  return (
    <Screen title="Devices" subtitle="Choose how to reach your power station">
      <Card inset>
        <SegmentedControl
          title="Connection"
          subtitle={
            source === 'server'
              ? 'The server holds the link over WiFi or its own Bluetooth adapter, and this app talks to the server.'
              : `This ${Platform.OS === 'web' ? 'browser' : 'phone'} connects to the station over Bluetooth directly. No server needed.`
          }
          value={source}
          options={SOURCES}
          onChange={setSource}
        />
      </Card>

      {source === 'server' ? (
        <ServerDevices status={status} refresh={refresh} />
      ) : (
        <DirectDevices direct={direct} />
      )}
    </Screen>
  );
}

/**
 * Discovery and binding through the server.
 *
 * Stations announce themselves differently per transport — over MQTT the first
 * message reveals the MAC, over BLE they advertise a name — but both end up here
 * as something you can bind. The binding is persisted server-side, so a restart
 * reconnects to the same unit.
 */
function ServerDevices({
  status,
  refresh,
}: {
  status: ReturnType<typeof useStation>['status'];
  refresh: () => Promise<void>;
}) {
  const [list, setList] = useState<DeviceList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const theme = useTheme();

  const load = useCallback(async () => {
    try {
      setList(await fetchDevices());
      setError(null);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const bind = useCallback(
    async (id: string) => {
      haptic();
      setBusy(true);
      try {
        await bindDevice(id);
        await Promise.all([load(), refresh()]);
        setError(null);
      } catch (err) {
        const message = describeError(err);
        if (message) setError(message);
      } finally {
        setBusy(false);
      }
    },
    [load, refresh]
  );

  const unbind = useCallback(async () => {
    haptic();
    setBusy(true);
    try {
      await unbindDevice();
      await Promise.all([load(), refresh()]);
    } catch (err) {
      const message = describeError(err);
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  }, [load, refresh]);

  const simulated = status?.link.mode === 'simulator';

  return (
    <>
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger">
            {error}
          </Text>
        </Card>
      ) : null}

      {simulated ? (
        <Card borderColor="$warning" gap="$2">
          <XStack alignItems="center" gap="$2">
            <Feather name="cpu" size={15} color={theme.warning?.val} />
            <Text fontSize={14} fontWeight="700" color="$warning">
              Running the simulator
            </Text>
          </XStack>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            Start the server with STATION_DRIVER=device for WiFi, or STATION_DRIVER=ble for
            Bluetooth, to discover real hardware.
          </Text>
        </Card>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>Link</SectionLabel>
        <Card inset>
          <Row
            title="Transport"
            accessory={
              <Text fontSize={15} fontWeight="700" color="$color">
                {list?.transport === 'ble'
                  ? 'Bluetooth LE'
                  : list?.transport === 'mqtt'
                    ? 'WiFi / MQTT'
                    : 'Simulator'}
              </Text>
            }
          />
          <RowSeparator />
          <Row
            title="Bound station"
            subtitle={list?.boundId ?? 'None'}
            accessory={
              <XStack alignItems="center" gap="$2">
                <YStack
                  width={8}
                  height={8}
                  borderRadius={999}
                  backgroundColor={list?.connected ? '$success' : '$muted'}
                />
                <Text fontSize={13} color="$muted">
                  {list?.connected ? 'live' : 'no data'}
                </Text>
              </XStack>
            }
          />
          <RowSeparator />
          <Row
            title="Auto-bind"
            subtitle={
              list?.autoBind
                ? 'Adopts the first identified station; retries with backoff'
                : 'Disabled — bind manually below'
            }
          />
          {list?.lastError ? (
            <>
              <RowSeparator />
              <Row
                title="Last connect error"
                subtitle={list.lastError}
                accessory={
                  <Text fontSize={13} color="$muted">
                    {list.attempts ?? 0} tries
                  </Text>
                }
              />
            </>
          ) : null}
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Discovered</SectionLabel>
        <Card inset>
          {!list ? (
            <YStack padding="$5" alignItems="center">
              <Spinner color="$accent" />
            </YStack>
          ) : list.devices.length === 0 ? (
            <Row
              title="Nothing found yet"
              subtitle={
                list.transport === 'ble'
                  ? 'Make sure the P280 is powered on and Bluetooth is enabled on it.'
                  : 'Point mqtt.sydpower.com at this machine, then power-cycle the P280.'
              }
            />
          ) : (
            // Stations first; unidentified peripherals sink to the bottom.
            [...list.devices]
              .sort((a, b) => Number(b.likelyStation) - Number(a.likelyStation))
              .map((found, index) => (
                <YStack key={found.id} opacity={found.likelyStation ? 1 : 0.55}>
                  {index > 0 ? <RowSeparator /> : null}
                  <DeviceRow
                    name={found.name}
                    detail={`${found.mac ?? found.id}${
                      found.rssi !== undefined ? ` · ${found.rssi} dBm` : ''
                    }${found.likelyStation ? '' : ' · not identified as a station'}`}
                    icon={found.kind === 'mqtt' ? 'wifi' : 'bluetooth'}
                    active={found.bound}
                    action={
                      found.bound ? (
                        <Button size="$2" disabled={busy} onPress={() => void unbind()}>
                          Unbind
                        </Button>
                      ) : (
                        <Button
                          size="$2"
                          backgroundColor={found.likelyStation ? '$accent' : undefined}
                          color={found.likelyStation ? '$background' : undefined}
                          disabled={busy}
                          onPress={() => void bind(found.id)}
                        >
                          {found.likelyStation ? 'Bind' : 'Try anyway'}
                        </Button>
                      )
                    }
                  />
                </YStack>
              ))
          )}
        </Card>
      </YStack>
    </>
  );
}

/** The app's own Bluetooth link: chooser or scan, connect, and the write guard. */
function DirectDevices({ direct }: { direct: ReturnType<typeof useStation>['direct'] }) {
  const { support, devices, boundId, connected, readOnly, busy, scanning, error } = direct;
  const { remembered, resuming } = direct;
  const isWeb = Platform.OS === 'web';

  /** The station's advertised name beats an opaque per-origin id in the UI. */
  const boundName =
    devices.find((device) => device.id === boundId)?.name ??
    (remembered?.id === boundId ? remembered.name : null);

  if (!support.supported) {
    return (
      <Card borderColor="$warning" gap="$2">
        <XStack alignItems="center" gap="$2">
          <Feather name="bluetooth" size={15} color="$warning" />
          <Text fontSize={14} fontWeight="700" color="$warning">
            Direct Bluetooth is not available here
          </Text>
        </XStack>
        <Text fontSize={12} color="$muted" lineHeight={18}>
          {support.reason}
        </Text>
      </Card>
    );
  }

  return (
    <>
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger" lineHeight={19}>
            {error}
          </Text>
        </Card>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>Link</SectionLabel>
        <Card inset>
          <Row
            title="Transport"
            subtitle="Frames go straight from this app to the station"
            accessory={
              <Text fontSize={15} fontWeight="700" color="$color">
                {support.label}
              </Text>
            }
          />
          <RowSeparator />
          <Row
            title="Connected station"
            subtitle={boundName ?? boundId ?? 'None'}
            accessory={
              <XStack alignItems="center" gap="$2">
                {resuming ? <Spinner size="small" color="$accent" /> : null}
                <YStack
                  width={8}
                  height={8}
                  borderRadius={999}
                  backgroundColor={connected ? '$success' : '$muted'}
                />
                <Text fontSize={13} color="$muted">
                  {connected ? 'live' : resuming ? 'reconnecting' : 'not connected'}
                </Text>
              </XStack>
            }
          />
          <RowSeparator />
          {/*
            Writes are refused by default, exactly as the server's hardware modes
            are. The guard is in the shared StationClient, not in this screen —
            this switch only asks for it.
          */}
          <ToggleRow
            title="Allow writes"
            subtitle={
              readOnly
                ? 'Read-only. Nothing can change on the station.'
                : 'Settings and ports can be changed. Writing an undocumented register can destroy the station — the whitelist still applies.'
            }
            checked={!readOnly}
            onCheckedChange={(next) => direct.setReadOnly(!next)}
          />
        </Card>
      </YStack>

      {/*
        The station you were last on, offered first. A reload reconnects to it
        on its own where the platform allows that; where it doesn't — a browser
        that didn't keep the Bluetooth permission — this is the one tap back,
        and the chooser it opens is filtered to this station alone.
      */}
      {remembered && !connected ? (
        <YStack gap="$2">
          <SectionLabel>Last used</SectionLabel>
          <Card inset>
            <Row
              title={remembered.name}
              subtitle={
                resuming
                  ? 'Reconnecting…'
                  : `Connected ${formatAgo(remembered.at)}${
                      remembered.autoConnect ? '' : ' · you disconnected this one'
                    }`
              }
              accessory={
                resuming ? (
                  <Spinner size="small" color="$accent" />
                ) : (
                  <Button
                    size="$2"
                    backgroundColor="$accent"
                    color="$background"
                    disabled={busy}
                    onPress={() => {
                      haptic();
                      direct.reconnect();
                    }}
                  >
                    Reconnect
                  </Button>
                )
              }
            />
            <RowSeparator />
            <Row
              title="Forget this station"
              subtitle="Stops offering it here and on the next launch"
              accessory={
                <Button size="$2" disabled={busy || resuming} onPress={() => direct.forget()}>
                  Forget
                </Button>
              }
            />
          </Card>
        </YStack>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>
          {remembered && !connected
            ? 'Another station'
            : isWeb
              ? 'Choose a station'
              : 'Nearby'}
        </SectionLabel>
        <Card inset>
          <YStack padding="$4" gap="$3">
            <Text fontSize={12} color="$muted" lineHeight={18}>
              {isWeb
                ? 'The browser picks the device, not the page: this opens its Bluetooth chooser. Close the vendor app first — these stations accept one connection at a time.'
                : 'Close the vendor app first — these stations accept one connection at a time, and while a phone holds it the vendor services are invisible.'}
            </Text>
            <XStack gap="$2">
              <Button
                flex={1}
                size="$3"
                backgroundColor="$accent"
                color="$background"
                disabled={busy}
                icon={busy ? undefined : <Feather name="bluetooth" size={15} />}
                onPress={() => {
                  haptic();
                  direct.pick();
                }}
              >
                {busy ? 'Working…' : isWeb ? 'Choose station' : scanning ? 'Scanning…' : 'Scan'}
              </Button>
              {isWeb ? (
                <Button
                  size="$3"
                  disabled={busy}
                  onPress={() => {
                    haptic();
                    direct.pick(true);
                  }}
                >
                  Show all
                </Button>
              ) : scanning ? (
                <Button size="$3" onPress={() => direct.stopScan()}>
                  Stop
                </Button>
              ) : null}
            </XStack>
          </YStack>

          {devices.length > 0 ? <RowSeparator /> : null}

          {[...devices]
            .sort((a, b) => Number(b.likelyStation) - Number(a.likelyStation))
            .map((found, index) => (
              <YStack key={found.id} opacity={found.likelyStation ? 1 : 0.55}>
                {index > 0 ? <RowSeparator /> : null}
                <DeviceRow
                  name={found.name}
                  detail={`${found.rssi !== undefined ? `${found.rssi} dBm · ` : ''}${
                    found.likelyStation ? 'identified as a station' : 'not identified as a station'
                  }`}
                  icon="bluetooth"
                  active={found.id === boundId}
                  action={
                    found.id === boundId ? (
                      <Button size="$2" disabled={busy} onPress={() => void direct.disconnect()}>
                        Disconnect
                      </Button>
                    ) : (
                      <Button
                        size="$2"
                        backgroundColor={found.likelyStation ? '$accent' : undefined}
                        color={found.likelyStation ? '$background' : undefined}
                        disabled={busy}
                        onPress={() => void direct.connect(found.id)}
                      >
                        Connect
                      </Button>
                    )
                  }
                />
              </YStack>
            ))}
        </Card>
      </YStack>
    </>
  );
}

/** One discovered device: what it is, how strong, and what you can do with it. */
function DeviceRow({
  name,
  detail,
  icon,
  active,
  action,
}: {
  name: string;
  detail: string;
  icon: React.ComponentProps<typeof Feather>['name'];
  active: boolean;
  action: React.ReactNode;
}) {
  const theme = useTheme();

  return (
    <XStack
      alignItems="center"
      justifyContent="space-between"
      gap="$3"
      paddingHorizontal="$4"
      paddingVertical="$3"
    >
      <YStack flex={1} gap={2}>
        <XStack alignItems="center" gap="$2">
          <Feather name={icon} size={13} color={active ? theme.success?.val : theme.muted?.val} />
          <Text fontSize={15} fontWeight="600" color="$color" numberOfLines={1}>
            {name}
          </Text>
        </XStack>
        <Text fontSize={12} color="$muted" numberOfLines={1}>
          {detail}
        </Text>
      </YStack>
      {action}
    </XStack>
  );
}
