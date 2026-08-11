import { Spinner, Text, YStack } from 'tamagui';

import { Card, SectionLabel } from '../../src/components/Card';
import { Row, RowSeparator, ToggleRow } from '../../src/components/Row';
import { Screen } from '../../src/components/Screen';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import { SliderRow } from '../../src/components/SliderRow';
import { formatWatts } from '../../src/lib/format';
import type { ChargeSpeed } from '../../src/lib/types';
import { useStation } from '../../src/state/StationProvider';

const CHARGE_SPEEDS = [
  { value: 'silent', label: 'Silent' },
  { value: 'standard', label: 'Standard' },
  { value: 'turbo', label: 'Turbo' },
] as const satisfies readonly { value: ChargeSpeed; label: string }[];

const TEMPERATURE_UNITS = [
  { value: 'C', label: 'Celsius' },
  { value: 'F', label: 'Fahrenheit' },
] as const;

export default function SettingsScreen() {
  const { settings, status, version, apiBaseUrl, updateSettings, setGridConnected } = useStation();

  if (!settings) {
    return (
      <Screen title="Settings">
        <Card alignItems="center" paddingVertical="$8" gap="$4">
          <Spinner size="large" color="$accent" />
          <Text color="$muted" fontSize={13}>
            Loading settings from {apiBaseUrl}
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title="Settings" subtitle="Changes are saved to the server immediately">
      <YStack gap="$2">
        <SectionLabel>Battery</SectionLabel>
        <Card inset>
          <SliderRow
            title="Charge limit"
            subtitle="Stop charging here. Around 80–90% meaningfully extends pack life."
            value={settings.chargeLimit}
            min={50}
            max={100}
            step={5}
            format={(v) => `${v}%`}
            onCommit={(chargeLimit) => void updateSettings({ chargeLimit })}
          />
          <RowSeparator />
          <SliderRow
            title="Discharge floor"
            subtitle="Outputs cut off below this level to protect the cells."
            value={settings.dischargeFloor}
            min={0}
            max={Math.max(0, settings.chargeLimit - 10)}
            step={5}
            format={(v) => `${v}%`}
            onCommit={(dischargeFloor) => void updateSettings({ dischargeFloor })}
          />
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Charging</SectionLabel>
        <Card inset>
          <SegmentedControl
            title="Charge speed"
            subtitle="Turbo is fastest; silent keeps the fans down."
            value={settings.chargeSpeed}
            options={CHARGE_SPEEDS}
            onChange={(chargeSpeed) => void updateSettings({ chargeSpeed })}
          />
          <RowSeparator />
          <SliderRow
            title="Max AC input"
            subtitle="Cap the draw so the station shares a weak circuit safely."
            value={settings.maxInputWatts}
            min={200}
            max={1500}
            step={50}
            format={formatWatts}
            onCommit={(maxInputWatts) => void updateSettings({ maxInputWatts })}
          />
          <RowSeparator />
          <ToggleRow
            title="Quiet hours"
            subtitle="Throttle the fans overnight, at the cost of charge speed."
            checked={settings.quietHours}
            onCheckedChange={(quietHours) => void updateSettings({ quietHours })}
          />
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Power behaviour</SectionLabel>
        <Card inset>
          <ToggleRow
            title="Eco mode"
            subtitle="Shut outputs off automatically when nothing is drawing power."
            checked={settings.ecoMode}
            onCheckedChange={(ecoMode) => void updateSettings({ ecoMode })}
          />
          <RowSeparator />
          <ToggleRow
            title="UPS / pass-through"
            subtitle="Run connected gear from the wall and switch to battery instantly on an outage."
            checked={settings.upsMode}
            onCheckedChange={(upsMode) => void updateSettings({ upsMode })}
          />
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Display</SectionLabel>
        <Card inset>
          <SliderRow
            title="Screen brightness"
            value={settings.displayBrightness}
            min={10}
            max={100}
            step={10}
            format={(v) => `${v}%`}
            onCommit={(displayBrightness) => void updateSettings({ displayBrightness })}
          />
          <RowSeparator />
          <SliderRow
            title="Screen timeout"
            subtitle="Minutes of inactivity before the built-in display sleeps."
            value={settings.screenTimeoutMinutes}
            min={0}
            max={60}
            step={5}
            format={(v) => (v === 0 ? 'Never' : `${v} min`)}
            onCommit={(screenTimeoutMinutes) => void updateSettings({ screenTimeoutMinutes })}
          />
          <RowSeparator />
          <SegmentedControl
            title="Temperature unit"
            value={settings.temperatureUnit}
            options={TEMPERATURE_UNITS}
            onChange={(temperatureUnit) => void updateSettings({ temperatureUnit })}
          />
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Developer</SectionLabel>
        <Card inset>
          <ToggleRow
            title="Grid connected"
            subtitle="Simulate pulling the wall plug, to exercise the discharge path."
            checked={status?.gridConnected ?? true}
            onCheckedChange={(connected) => void setGridConnected(connected)}
          />
          <RowSeparator />
          <Row title="API endpoint" subtitle={apiBaseUrl} />
          <RowSeparator />
          <Row
            title="Server"
            subtitle={version ? `${version.name} · ${version.runtime}` : 'Not connected'}
            accessory={
              <Text fontSize={15} fontWeight="700" color="$color">
                {version ? `v${version.version}` : '—'}
              </Text>
            }
          />
        </Card>
      </YStack>
    </Screen>
  );
}
