import { Spinner, Text, YStack } from 'tamagui';

import { Card, SectionLabel } from '../../src/components/Card';
import { ModeRow } from '../../src/components/ModeRow';
import { Row, RowSeparator, ToggleRow } from '../../src/components/Row';
import { Screen } from '../../src/components/Screen';
import { SegmentedControl } from '../../src/components/SegmentedControl';
import { SliderRow } from '../../src/components/SliderRow';
import { formatDuration } from '../../src/lib/format';
import type { LedMode } from '../../src/lib/types';
import { useStation } from '../../src/state/StationProvider';

const LED_MODES = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
  { value: 'sos', label: 'SOS' },
  { value: 'flash', label: 'Flash' },
] as const satisfies readonly { value: LedMode; label: string }[];

const TEMPERATURE_UNITS = [
  { value: 'C', label: 'Celsius' },
  { value: 'F', label: 'Fahrenheit' },
] as const;

const STANDBY_LONG = [
  { value: 0, label: 'Never' },
  { value: 480, label: '8h' },
  { value: 960, label: '16h' },
  { value: 1440, label: '24h' },
] as const;

const SLEEP = [
  { value: 5, label: '5m' },
  { value: 10, label: '10m' },
  { value: 30, label: '30m' },
  { value: 480, label: '8h' },
] as const;

/** Register 62 holds seconds. These are the four values BrightEMS offers. */
const SCREEN_TIMEOUTS = [
  { value: 180, label: '3 min' },
  { value: 300, label: '5 min' },
  { value: 600, label: '10 min' },
  { value: 1800, label: '30 min' },
] as const;

const DC_INPUT_TYPES = [
  { value: 'pv', label: 'Solar (PV)' },
  { value: 'dc', label: 'DC adapter' },
] as const;

/** Confirmed on a P280: register 13 steps 1-5 map to these watts. */
const AC_CHARGING_POWER = [
  { value: 600, label: '600 W' },
  { value: 900, label: '900 W' },
  { value: 1200, label: '1.2 kW' },
  { value: 1500, label: '1.5 kW' },
  { value: 1800, label: '1.8 kW' },
] as const;

/** 1439, not 1440 — that is the register's maximum. */
const CHARGE_DELAYS = [
  { value: 0, label: 'Now' },
  { value: 60, label: '1h' },
  { value: 240, label: '4h' },
  { value: 480, label: '8h' },
  { value: 720, label: '12h' },
  { value: 1439, label: '24h' },
] as const;

/**
 * The device counts this register down every minute, so a running timer almost
 * never equals a preset exactly. Highlight the preset it started from.
 */
function nearestDelay(minutes: number): (typeof CHARGE_DELAYS)[number]['value'] {
  if (minutes <= 0) return 0;
  // Smallest preset still at or above the remaining time.
  return CHARGE_DELAYS.find((delay) => delay.value >= minutes)?.value ?? 1439;
}

export default function SettingsScreen() {
  const { settings, status, version, apiBaseUrl, updateSettings } = useStation();

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

  const simulated = status?.link.mode === 'simulator';
  const readOnly = version?.readOnly ?? false;

  return (
    <Screen
      title="Settings"
      subtitle={
        readOnly
          ? 'Read-only — nothing here will reach the station'
          : simulated
            ? 'Simulator — not a real device'
            : 'Written straight to the P280'
      }
    >
      {readOnly ? (
        <Card borderColor="$success" gap="$2">
          <Text fontSize={14} fontWeight="700" color="$success">
            Read-only mode
          </Text>
          <Text fontSize={12} color="$muted" lineHeight={18}>
            These controls still show what the station reports, but every write is refused. Restart
            the server without --read-only when you are ready to make changes.
          </Text>
        </Card>
      ) : null}

      <YStack gap="$2">
        <SectionLabel>Battery</SectionLabel>
        <Card inset>
          {/* Step 1, not 5: the station stores tenths of a percent and accepts
              arbitrary values — a P280 set to 23% reads 230. A coarser step
              would make settings unreachable that the hardware supports. */}
          <SliderRow
            title="AC charge limit"
            subtitle="Caps charging from mains only — solar will still fill the pack past this."
            value={settings.chargeLimit}
            min={60}
            max={100}
            step={1}
            format={(v) => `${v}%`}
            onCommit={(chargeLimit) => void updateSettings({ chargeLimit })}
          />
          <RowSeparator />
          <SliderRow
            title="Discharge floor"
            subtitle="Outputs cut off below this level. The device allows 0-50%."
            value={settings.dischargeFloor}
            min={0}
            max={50}
            step={1}
            format={(v) => `${v}%`}
            onCommit={(dischargeFloor) => void updateSettings({ dischargeFloor })}
          />
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Charging</SectionLabel>
        <Card inset>
          {/* Five discrete steps on the device (register 13 stores 1-5). The
              watt values are P280-specific — an F2400 spans 300-1100 W. */}
          <ModeRow
            title="AC charging power"
            subtitle="How hard the station pulls from the wall."
            value={settings.acChargingWatts}
            options={AC_CHARGING_POWER}
            onChange={(acChargingWatts) => void updateSettings({ acChargingWatts })}
          />
          <RowSeparator />
          <ToggleRow
            title="Silent AC charging"
            subtitle="Slower, but keeps the fans down."
            checked={settings.acSilentCharging}
            onCheckedChange={(acSilentCharging) => void updateSettings({ acSilentCharging })}
          />
          <RowSeparator />
          <SegmentedControl
            title="DC input type"
            subtitle="What is plugged into the XT90 input. Changing this also moves the current ceiling below."
            value={settings.dcInputType}
            options={DC_INPUT_TYPES}
            onChange={(dcInputType) => void updateSettings({ dcInputType })}
          />
          <RowSeparator />
          {/* The ceiling is mode-dependent: 20 A on a solar array, 8 A on a DC
              adapter. Offering 20 A in DC mode would just get clamped. */}
          <SliderRow
            title="Max charging current"
            subtitle={
              settings.dcInputType === 'dc'
                ? 'Ceiling for the XT90 input. DC mode allows up to 8 A.'
                : 'Ceiling for the XT90 input. Solar allows up to 20 A.'
            }
            value={Math.min(settings.maxChargingCurrent, settings.dcInputType === 'dc' ? 8 : 20)}
            min={1}
            max={settings.dcInputType === 'dc' ? 8 : 20}
            step={1}
            format={(v) => `${v} A`}
            onCommit={(maxChargingCurrent) => void updateSettings({ maxChargingCurrent })}
          />
          <RowSeparator />
          {/*
            This register is a live countdown on the device, not a setpoint: it
            ticks down once a minute and charging resumes at zero. A slider bound
            to it would drift under the user's finger, so offer fixed delays and
            report the remaining time separately.
          */}
          <ModeRow
            title="Delay AC charging"
            subtitle={
              settings.stopChargeAfterMinutes > 0
                ? `Charging starts in ${formatDuration(settings.stopChargeAfterMinutes)} — counting down`
                : 'Charging is enabled now. Useful on a time-of-use tariff.'
            }
            value={nearestDelay(settings.stopChargeAfterMinutes)}
            options={CHARGE_DELAYS}
            onChange={(stopChargeAfterMinutes) => void updateSettings({ stopChargeAfterMinutes })}
          />
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Light</SectionLabel>
        <Card inset>
          <SegmentedControl
            title="LED mode"
            value={settings.ledMode}
            options={LED_MODES}
            onChange={(ledMode) => void updateSettings({ ledMode })}
          />
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Auto shut-off</SectionLabel>
        <Card inset>
          <SegmentedControl
            title="AC standby"
            subtitle="Turn the inverter off after this long with no load."
            value={settings.acStandbyMinutes}
            options={STANDBY_LONG}
            onChange={(acStandbyMinutes) => void updateSettings({ acStandbyMinutes })}
          />
          <RowSeparator />
          <SegmentedControl
            title="DC standby"
            value={settings.dcStandbyMinutes}
            options={STANDBY_LONG}
            onChange={(dcStandbyMinutes) => void updateSettings({ dcStandbyMinutes })}
          />
          <RowSeparator />
          <SegmentedControl
            title="Whole unit sleep"
            subtitle="Idle time before the station powers down completely."
            value={settings.sleepMinutes}
            options={SLEEP}
            onChange={(sleepMinutes) => void updateSettings({ sleepMinutes })}
          />
        </Card>
      </YStack>

      <YStack gap="$2">
        <SectionLabel>Panel</SectionLabel>
        <Card inset>
          {/* Stored in seconds. BrightEMS offers exactly these four. */}
          <ModeRow
            title="Screen shutdown"
            subtitle="How long the station's own display stays lit."
            value={settings.screenRestSeconds}
            options={SCREEN_TIMEOUTS}
            onChange={(screenRestSeconds) => void updateSettings({ screenRestSeconds })}
          />
          <RowSeparator />
          <ToggleRow
            title="Key sound"
            checked={settings.keySound}
            onCheckedChange={(keySound) => void updateSettings({ keySound })}
          />
          <RowSeparator />
          <SegmentedControl
            title="Temperature unit"
            subtitle="Display preference only — the station has no register for this."
            value={settings.temperatureUnit}
            options={TEMPERATURE_UNITS}
            onChange={(temperatureUnit) => void updateSettings({ temperatureUnit })}
          />
          <RowSeparator />
          <Row
            title="API endpoint"
            subtitle={apiBaseUrl}
            accessory={<Text fontSize={13} color="$muted">{simulated ? 'sim' : 'device'}</Text>}
          />
        </Card>
      </YStack>
    </Screen>
  );
}
