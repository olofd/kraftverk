import { useCallback, useEffect, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { Button, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, SectionLabel } from '../../src/components/Card';
import { Row, RowSeparator } from '../../src/components/Row';
import { Screen } from '../../src/components/Screen';
import { bindDevice, describeError, fetchDevices, unbindDevice } from '../../src/lib/api';
import { haptic } from '../../src/lib/haptics';
import type { DeviceList } from '../../src/lib/types';
import { useStation } from '../../src/state/StationProvider';

/**
 * Discovery and binding.
 *
 * Stations announce themselves differently per transport — over MQTT the first
 * message reveals the MAC, over BLE they advertise a name — but both end up here
 * as something you can bind. The binding is persisted server-side, so a restart
 * reconnects to the same unit.
 */
export default function DevicesScreen() {
  const { status, refresh } = useStation();
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
    <Screen title="Devices" subtitle="Discover and bind your power station">
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
                <XStack
                  alignItems="center"
                  justifyContent="space-between"
                  gap="$3"
                  paddingHorizontal="$4"
                  paddingVertical="$3"
                >
                  <YStack flex={1} gap={2}>
                    <XStack alignItems="center" gap="$2">
                      <Feather
                        name={found.kind === 'ble' ? 'bluetooth' : 'wifi'}
                        size={13}
                        color={found.bound ? theme.success?.val : theme.muted?.val}
                      />
                      <Text fontSize={15} fontWeight="600" color="$color" numberOfLines={1}>
                        {found.name}
                      </Text>
                    </XStack>
                    <Text fontSize={12} color="$muted" numberOfLines={1}>
                      {found.mac ?? found.id}
                      {found.rssi !== undefined ? ` · ${found.rssi} dBm` : ''}
                      {found.likelyStation ? '' : ' · not identified as a station'}
                    </Text>
                  </YStack>

                  {found.bound ? (
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
                  )}
                </XStack>
              </YStack>
            ))
          )}
        </Card>
      </YStack>
    </Screen>
  );
}
