import type { ReactNode } from 'react';
import { Feather } from '@expo/vector-icons';
import { Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { AnimatedNumber } from '../../src/components/AnimatedNumber';
import { Card, SectionLabel } from '../../src/components/Card';
import { EnergyFlow } from '../../src/components/EnergyFlow';
import { ModeRow } from '../../src/components/ModeRow';
import { Row, RowSeparator, ToggleRow } from '../../src/components/Row';
import { Screen } from '../../src/components/Screen';
import {
  formatDuration,
  formatUptime,
  formatWatts,
  formatWh,
  STATE_TINT,
} from '../../src/lib/format';
import type { LedMode } from '../../src/lib/types';
import { useStation } from '../../src/state/StationProvider';

/** All four values confirmed against a real P280: 0 off, 1 on, 2 SOS, 3 flash. */
const LED_MODE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
  { value: 'sos', label: 'SOS' },
  { value: 'flash', label: 'Flash' },
] as const satisfies readonly { value: LedMode; label: string }[];

const LED_LABELS: Record<LedMode, string> = {
  off: 'Off',
  on: 'Always on',
  sos: 'SOS',
  flash: 'Flashing',
};

export default function DashboardScreen() {
  const { status, settings, version, apiBaseUrl, togglePort, updateSettings } = useStation();
  const theme = useTheme();

  if (!status) {
    return (
      <Screen title="Dashboard">
        <Card alignItems="center" paddingVertical="$8" gap="$4">
          <Spinner size="large" color="$accent" />
          <Text color="$muted" fontSize={13}>
            Connecting to {apiBaseUrl}
          </Text>
        </Card>
      </Screen>
    );
  }

  const tint = STATE_TINT[status.state];
  const storedWh = (status.level / 100) * status.capacityWh;
  const waitingForDevice = status.link.mode === 'device' && status.link.state !== 'connected';

  const eta =
    status.state === 'charging'
      ? `Full in ${formatDuration(status.minutesToFull)}`
      : status.state === 'discharging'
        ? `${formatDuration(status.minutesRemaining)} of runtime left`
        : status.chargeBookingMinutes > 0
          ? `Charging deferred ${formatDuration(status.chargeBookingMinutes)}`
          : 'Idle — no load';

  return (
    <Screen title={status.name} subtitle={status.model}>
      {waitingForDevice ? (
        <Card borderColor="$warning" gap="$2">
          <XStack alignItems="center" gap="$2">
            <Feather name="radio" size={15} color={theme.warning?.val} />
            <Text fontSize={14} fontWeight="700" color="$warning">
              {status.link.state === 'waiting' ? 'Waiting for the station' : 'Station offline'}
            </Text>
          </XStack>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            The API is up but the station has not connected yet.
          </Text>
        </Card>
      ) : null}

      {/* The centrepiece. Totals lead, because "how much in, how much out" is
          the first question; the diagram then answers "from where, to where". */}
      <Card paddingTop="$4" paddingBottom="$4" paddingHorizontal="$3" gap="$2">
        <XStack paddingHorizontal="$2">
          <YStack flex={1} gap={2}>
            <Text fontSize={12} fontWeight="700" color="$success" letterSpacing={0.4}>
              Input
            </Text>
            <AnimatedNumber
              value={status.totalInputWatts}
              format={formatWatts}
              fontSize={28}
              fontWeight="800"
              color={status.totalInputWatts > 0 ? '$color' : '$muted'}
            />
          </YStack>
          <YStack flex={1} gap={2} alignItems="flex-end">
            <Text fontSize={12} fontWeight="700" color="$warning" letterSpacing={0.4}>
              Output
            </Text>
            <AnimatedNumber
              value={status.totalOutputWatts}
              format={formatWatts}
              fontSize={28}
              fontWeight="800"
              color={status.totalOutputWatts > 0 ? '$color' : '$muted'}
            />
          </YStack>
        </XStack>

        <EnergyFlow status={status} chargeLimit={settings?.chargeLimit} />

        <YStack alignItems="center" gap="$1">
          <XStack alignItems="center" gap="$2">
            <YStack
              width={6}
              height={6}
              borderRadius={999}
              backgroundColor={tint}
              opacity={status.state === 'idle' || status.state === 'standby' ? 0.5 : 1}
            />
            <Text fontSize={14} color={tint} fontWeight="700">
              {eta}
            </Text>
          </XStack>
          <Text fontSize={12} color="$muted">
            {formatWh(storedWh)} of {formatWh(status.capacityWh)}
          </Text>
        </YStack>
      </Card>

      {/* Expansion packs — the P280 takes up to four */}
      {status.expansionSoc.length > 0 ? (
        <YStack gap="$2">
          <SectionLabel>Expansion batteries</SectionLabel>
          <Card inset>
            {status.expansionSoc.map((soc, index) => (
              <YStack key={index}>
                {index > 0 ? <RowSeparator /> : null}
                <Row
                  title={`Pack ${index + 1}`}
                  subtitle="2 048 Wh"
                  accessory={<Value>{soc.toFixed(1)}%</Value>}
                />
              </YStack>
            ))}
          </Card>
        </YStack>
      ) : null}

      {/* Output ports. The light has four modes, so it gets a selector rather
          than a switch, which would collapse SOS and flash into "on". */}
      <YStack gap="$2">
        <SectionLabel>Outputs</SectionLabel>
        <Card inset>
          {status.ports.map((port, index) => (
            <YStack key={port.id}>
              {index > 0 ? <RowSeparator /> : null}
              {port.id === 'led' ? (
                <ModeRow
                  title={port.label}
                  subtitle={
                    port.enabled
                      ? `${LED_LABELS[settings?.ledMode ?? 'off']} · ${formatWatts(port.watts)}`
                      : 'Off'
                  }
                  value={settings?.ledMode ?? 'off'}
                  options={LED_MODE_OPTIONS}
                  disabled={!settings}
                  onChange={(ledMode) => void updateSettings({ ledMode })}
                />
              ) : (
                <ToggleRow
                  title={port.label}
                  subtitle={port.enabled ? `Drawing ${formatWatts(port.watts)}` : 'Off'}
                  checked={port.enabled}
                  onCheckedChange={(next) => void togglePort(port.id, next)}
                />
              )}
            </YStack>
          ))}
        </Card>
      </YStack>

      {/* Mains detail */}
      <YStack gap="$2">
        <SectionLabel>AC</SectionLabel>
        <Card inset>
          <Row
            title="Grid input"
            subtitle={status.gridConnected ? 'Connected' : 'Not connected'}
            accessory={
              <Value>
                {status.gridConnected
                  ? `${status.acInputVolts.toFixed(1)} V · ${status.acInputHz.toFixed(1)} Hz`
                  : '—'}
              </Value>
            }
          />
          <RowSeparator />
          <Row
            title="Inverter output"
            accessory={
              <Value>
                {status.acOutputVolts > 0
                  ? `${status.acOutputVolts.toFixed(1)} V · ${status.acOutputHz.toFixed(1)} Hz`
                  : '—'}
              </Value>
            }
          />
        </Card>
      </YStack>

      {/* Link + server */}
      <YStack gap="$2">
        <SectionLabel>Connection</SectionLabel>
        <Card inset>
          <Row
            title="Link"
            subtitle={
              status.link.mode !== 'device'
                ? 'Built-in simulator'
                : status.link.transport === 'ble'
                  ? 'Bluetooth LE'
                  : 'Local MQTT over WiFi'
            }
            accessory={
              <Value>{status.link.mode === 'device' ? status.link.state : 'simulated'}</Value>
            }
          />
          {status.link.mac ? (
            <>
              <RowSeparator />
              <Row title="Device" accessory={<Value>{status.link.mac}</Value>} />
            </>
          ) : null}
          <RowSeparator />
          <Row
            title="Server"
            subtitle={version?.runtime}
            accessory={<Value>{version ? `v${version.version}` : '—'}</Value>}
          />
          <RowSeparator />
          <Row
            title="Uptime"
            accessory={<Value>{version ? formatUptime(version.uptimeSeconds) : '—'}</Value>}
          />
        </Card>
      </YStack>

      {/* Read-only. Registers 47-50, undocumented; AC and panel are certain,
          the two controllers both read 1.4 so their order is unresolved. */}
      {status.firmware ? (
        <YStack gap="$2">
          <SectionLabel>Firmware</SectionLabel>
          <Card inset>
            <Row title="AC converter" accessory={<Value>v{status.firmware.ac}</Value>} />
            <RowSeparator />
            <Row
              title="BMS / PV controller"
              subtitle="Both report the same version; the registers can't be told apart"
              accessory={
                <Value>
                  v{status.firmware.controllerA} · v{status.firmware.controllerB}
                </Value>
              }
            />
            <RowSeparator />
            <Row title="Panel" accessory={<Value>v{status.firmware.panel}</Value>} />
          </Card>
        </YStack>
      ) : null}
    </Screen>
  );
}


function Value({ children }: { children: ReactNode }) {
  return (
    <Text fontSize={15} fontWeight="700" color="$color" fontVariant={['tabular-nums']}>
      {children}
    </Text>
  );
}
