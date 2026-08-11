import type { ReactNode } from 'react';
import { Feather } from '@expo/vector-icons';
import { Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { Card, SectionLabel } from '../../src/components/Card';
import { ChargeMeter } from '../../src/components/ChargeMeter';
import { Row, RowSeparator, ToggleRow } from '../../src/components/Row';
import { Screen } from '../../src/components/Screen';
import { StatTile } from '../../src/components/StatTile';
import {
  formatDuration,
  formatTemperature,
  formatUptime,
  formatWatts,
  formatWh,
  STATE_LABELS,
  STATE_TINT,
} from '../../src/lib/format';
import { useStation } from '../../src/state/StationProvider';

export default function DashboardScreen() {
  const { status, settings, version, apiBaseUrl, togglePort } = useStation();
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
  const tintValue =
    status.state === 'charging'
      ? theme.success?.val
      : status.state === 'discharging'
        ? theme.warning?.val
        : theme.muted?.val;
  const storedWh = (status.level / 100) * status.capacityWh;
  const eta =
    status.state === 'charging'
      ? `Full in ${formatDuration(status.minutesToFull)}`
      : status.state === 'discharging'
        ? `${formatDuration(status.minutesRemaining)} remaining`
        : 'No load';

  return (
    <Screen title={status.name} subtitle={status.model}>
      {/* Hero: state of charge */}
      <Card gap="$4">
        <XStack alignItems="flex-start" justifyContent="space-between">
          <YStack>
            <XStack alignItems="baseline" gap="$1">
              <Text fontSize={56} fontWeight="800" letterSpacing={-2.5} color="$color">
                {Math.round(status.level)}
              </Text>
              <Text fontSize={24} fontWeight="700" color="$muted">
                %
              </Text>
            </XStack>
            <Text fontSize={13} color="$muted">
              {formatWh(storedWh)} of {formatWh(status.capacityWh)}
            </Text>
          </YStack>

          <XStack
            alignItems="center"
            gap="$2"
            paddingHorizontal="$3"
            paddingVertical="$2"
            borderRadius={999}
            backgroundColor="$backgroundStrong"
            borderWidth={1}
            borderColor="$borderColor"
          >
            <Feather
              name={
                status.state === 'charging'
                  ? 'zap'
                  : status.state === 'discharging'
                    ? 'battery'
                    : 'pause'
              }
              size={13}
              color={tintValue}
            />
            <Text fontSize={12} fontWeight="700" color={tint}>
              {STATE_LABELS[status.state]}
            </Text>
          </XStack>
        </XStack>

        <ChargeMeter
          level={status.level}
          chargeLimit={settings?.chargeLimit ?? 100}
          state={status.state}
        />

        <Text fontSize={13} color="$muted">
          {eta}
        </Text>
      </Card>

      {/* Live telemetry */}
      <XStack gap="$3" flexWrap="wrap">
        <StatTile
          icon="download"
          label="INPUT"
          value={formatWatts(status.inputWatts)}
          tone={status.inputWatts > 0 ? 'success' : 'muted'}
        />
        <StatTile
          icon="upload"
          label="OUTPUT"
          value={formatWatts(status.outputWatts)}
          tone={status.outputWatts > 0 ? 'warning' : 'muted'}
        />
        <StatTile
          icon="thermometer"
          label="BATTERY"
          value={formatTemperature(status.batteryTempC, settings?.temperatureUnit ?? 'C')}
          tone={status.batteryTempC > 45 ? 'danger' : 'color'}
        />
      </XStack>

      {/* Output ports */}
      <YStack gap="$2">
        <SectionLabel>Outputs</SectionLabel>
        <Card inset>
          {status.ports.map((port, index) => (
            <YStack key={port.id}>
              {index > 0 ? <RowSeparator /> : null}
              <ToggleRow
                title={port.label}
                subtitle={port.enabled ? `Drawing ${formatWatts(port.watts)}` : 'Off'}
                checked={port.enabled}
                onCheckedChange={(next) => void togglePort(port.id, next)}
              />
            </YStack>
          ))}
        </Card>
      </YStack>

      {/* Battery health */}
      <YStack gap="$2">
        <SectionLabel>Battery health</SectionLabel>
        <Card inset>
          <Row title="Cycle count" accessory={<Value>{status.cycleCount}</Value>} />
          <RowSeparator />
          <Row
            title="Estimated health"
            accessory={<Value>{status.healthPercent.toFixed(1)}%</Value>}
          />
        </Card>
      </YStack>

      {/* Server identity — the thing this prototype set out to prove */}
      <YStack gap="$2">
        <SectionLabel>API server</SectionLabel>
        <Card inset>
          <Row
            title="Version"
            subtitle={version?.name}
            accessory={<Value>{version ? `v${version.version}` : '—'}</Value>}
          />
          <RowSeparator />
          <Row title="Runtime" accessory={<Value>{version?.runtime ?? '—'}</Value>} />
          <RowSeparator />
          <Row
            title="Uptime"
            accessory={<Value>{version ? formatUptime(version.uptimeSeconds) : '—'}</Value>}
          />
          <RowSeparator />
          <Row title="Endpoint" subtitle={apiBaseUrl} />
        </Card>
      </YStack>
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
