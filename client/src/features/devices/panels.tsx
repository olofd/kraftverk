import { useCallback, useEffect, useState } from 'react';
import { Alert, Platform } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { ACTUATOR_CONFIRMATION } from '@kraftverk/plugin-sdk';
import type { ConfigValues, ControlSpec, SavedDeviceView, MeasurementSpec } from '@kraftverk/api-client';
import { describeError, isOnline } from '@kraftverk/api-client';
import {
  Card,
  ModeRow,
  Row,
  RowSeparator,
  SchemaForm,
  SectionLabel,
  ToggleRow,
  DeviceCard,
  formatMeasurement,
  haptic,
  readingFor,
} from '@kraftverk/ui';

import { MeasurementChart } from '../../components/MeasurementChart';
import { featherName } from '../../lib/icons';
import { useDevices } from '../../state/DevicesProvider';

/**
 * What every device gets for free.
 *
 * Written entirely against declarations: the controls come from what the device
 * says it can be told to do, the rows from what it says it measures, and the
 * settings form from the schema it publishes. Nothing here knows what a power
 * station is, which is the test the device model has to pass — a plug added
 * next year lands on these panels with no code written for it.
 *
 * A device model rich enough to deserve its own screens replaces the panels it
 * wants and keeps the rest. They are grouped by *what is shown* — Dashboard or
 * Settings — rather than by generic versus specific, so replacing one is a
 * choice about a section rather than about a whole screen.
 */

export function Overview({ device }: { device: SavedDeviceView }) {
  const theme = useTheme();

  return (
    <DeviceCard
      device={device}
      icon={
        <Feather
          name={featherName(device.icon, 'zap')}
          size={16}
          color={isOnline(device.health) ? theme.accent?.val : theme.muted?.val}
        />
      }
    />
  );
}

// --- controls ---------------------------------------------------------------

/**
 * What this device can be told to do.
 *
 * A control that is `dangerous` asks twice and says what will happen first —
 * and the confirmation it then sends is the same token the action gateway
 * demands, so a tap here has exactly the authority a manual switch does.
 */
export function Controls({ device }: { device: SavedDeviceView }) {
  const { invoke } = useDevices();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (control: ControlSpec, value: boolean | number | string) => {
      setBusy(control.id);
      setError(null);
      try {
        await invoke(device, control.id, value, control.dangerous ? ACTUATOR_CONFIRMATION : undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That did not work');
      } finally {
        setBusy(null);
      }
    },
    [device, invoke]
  );

  const request = useCallback(
    (control: ControlSpec, value: boolean | number | string) => {
      haptic();
      if (!control.dangerous) {
        void run(control, value);
        return;
      }
      confirmDangerous(control, () => void run(control, value));
    },
    [run]
  );

  if (device.controls.length === 0) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>Controls</SectionLabel>
      <Card inset>
        {device.controls.map((control, index) => {
          const reading = control.measurementKey
            ? readingFor(device.readings, control.measurementKey)
            : undefined;

          return (
            <YStack key={control.id}>
              {index > 0 ? <RowSeparator /> : null}
              {control.kind === 'switch' ? (
                <ToggleRow
                  title={control.label}
                  subtitle={control.consequence}
                  checked={reading?.value === true}
                  disabled={!isOnline(device.health) || busy === control.id}
                  onCheckedChange={(next) => request(control, next)}
                />
              ) : control.kind === 'enum' && control.options ? (
                <ModeRow
                  title={control.label}
                  subtitle={control.consequence}
                  value={String(reading?.value ?? control.options[0]?.value ?? '')}
                  options={control.options}
                  disabled={!isOnline(device.health) || busy === control.id}
                  onChange={(next) => request(control, next)}
                />
              ) : (
                <Row
                  title={control.label}
                  subtitle={control.consequence}
                  disabled={!isOnline(device.health) || busy === control.id}
                  accessory={
                    <Button
                      size="$2"
                      disabled={!isOnline(device.health) || busy === control.id}
                      onPress={() => request(control, true)}
                    >
                      Run
                    </Button>
                  }
                />
              )}
            </YStack>
          );
        })}
      </Card>

      {error ? (
        <Text fontSize={12} color="$danger" lineHeight={18} paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}

/**
 * Asks before something physical happens.
 *
 * `Alert` is not available on web, where a browser `confirm` is the honest
 * equivalent — both block until the user has actually decided.
 */
function confirmDangerous(control: ControlSpec, proceed: () => void): void {
  const message = control.consequence ?? `${control.label} moves real hardware. Continue?`;

  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (typeof confirm === 'function' && confirm(`${control.label}\n\n${message}`)) proceed();
    return;
  }

  Alert.alert(control.label, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Continue', style: 'destructive', onPress: proceed },
  ]);
}

// --- readings ---------------------------------------------------------------

/** Everything the device declared it measures, and what it last said. */
export function Readings({ device }: { device: SavedDeviceView }) {
  if (device.measurements.length === 0) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>Readings</SectionLabel>
      <Card inset>
        {device.measurements.map((spec, index) => (
          <YStack key={spec.key}>
            {index > 0 ? <RowSeparator /> : null}
            <Row
              title={spec.label}
              accessory={
                <Text fontSize={15} fontWeight="700" color="$color">
                  {formatMeasurement(spec, readingFor(device.readings, spec.key)?.value ?? null)}
                </Text>
              }
            />
          </YStack>
        ))}
      </Card>
    </YStack>
  );
}

// --- history ----------------------------------------------------------------

/**
 * One chart, and a way to point it at any measurement.
 *
 * The sampler records everything a device declares, so the picker is simply the
 * declaration list — which is why this section needs no knowledge of what is
 * being charted.
 */
export function History({ device }: { device: SavedDeviceView }) {
  const { editable } = useDevices();
  const chartable = device.measurements.filter((spec) => spec.kind !== 'state');
  const [key, setKey] = useState<string | null>(null);

  const selected: MeasurementSpec | undefined =
    chartable.find((spec) => spec.key === key) ??
    chartable.find((spec) => spec.primary) ??
    chartable[0];

  // No server, no sampler, no history. Saying so beats an empty chart.
  if (!editable || !selected) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>History</SectionLabel>
      <Card gap="$3">
        <XStack flexWrap="wrap" gap="$1.5">
          {chartable.map((spec) => (
            // A chip is a choice, not a decoration: `radio` is what makes a
            // screen reader say which of the twelve is currently charted.
            <Text
              key={spec.key}
              role="radio"
              tabIndex={0}
              aria-checked={spec.key === selected.key}
              fontSize={12}
              fontWeight="600"
              paddingHorizontal="$2.5"
              paddingVertical="$1.5"
              borderRadius="$3"
              backgroundColor={spec.key === selected.key ? '$accent' : '$backgroundPress'}
              color={spec.key === selected.key ? '$background' : '$muted'}
              cursor="pointer"
              pressStyle={{ opacity: 0.7 }}
              focusVisibleStyle={{ outlineColor: '$accent', outlineWidth: 2, outlineStyle: 'solid' }}
              onPress={() => {
                haptic();
                setKey(spec.key);
              }}
            >
              {spec.label}
            </Text>
          ))}
        </XStack>

        <MeasurementChart deviceId={device.id} measurement={selected} />
      </Card>
    </YStack>
  );
}

// --- settings ---------------------------------------------------------------

/**
 * The device's own settings, rendered from the schema it publishes.
 *
 * Edits are held locally until Save: writing a register per keystroke would put
 * the station through a dozen writes to reach one value, and every one of them
 * is a real write to real hardware.
 */
export function GenericSettings({ device }: { device: SavedDeviceView }) {
  const { readSettings, writeSettings } = useDevices();
  const [values, setValues] = useState<ConfigValues | null>(null);
  const [draft, setDraft] = useState<ConfigValues>({});
  const [dangerous, setDangerous] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void readSettings(device)
      .then((loaded) => {
        if (!live) return;
        setValues(loaded.values);
        setDangerous(loaded.dangerous);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : 'Could not read settings');
      });
    return () => {
      live = false;
    };
    // Re-reading on every poll would fight the form; the device id is what matters.
  }, [device.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const schema = device.settings?.schema;
  if (!schema) return null;

  const pending = Object.keys(draft).length > 0;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      // The reply is a readback: one setting can move another on this hardware.
      const applied = await writeSettings(device, draft);
      setValues((current) => ({ ...current, ...applied }));
      setDraft({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That write was refused');
    } finally {
      setBusy(false);
    }
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Settings</SectionLabel>

      {dangerous.length > 0 ? (
        <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
          {dangerous.length === 1 ? 'One setting here can' : `${dangerous.length} settings here can`}{' '}
          damage the hardware if set wrongly. The device says which; their descriptions explain what
          happens.
        </Text>
      ) : null}

      <Card inset>
        {values === null ? (
          <YStack padding="$5" alignItems="center">
            <Spinner color="$accent" />
          </YStack>
        ) : (
          <SchemaForm
            schema={schema}
            values={{ ...values, ...draft }}
            disabled={busy || !isOnline(device.health)}
            onChange={(name, value) =>
              setDraft((current) => ({ ...current, [name]: value as ConfigValues[string] }))
            }
          />
        )}
      </Card>

      {error ? (
        <Text fontSize={12} color="$danger" lineHeight={18} paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}

      {pending ? (
        <XStack gap="$2">
          <Button flex={1} size="$3" disabled={busy} onPress={() => setDraft({})}>
            Discard
          </Button>
          <Button
            flex={1}
            size="$3"
            backgroundColor="$accent"
            color="$background"
            disabled={busy}
            onPress={() => {
              haptic();
              void save();
            }}
          >
            {busy ? 'Writing…' : 'Save'}
          </Button>
        </XStack>
      ) : null}
    </YStack>
  );
}

// --- manage -----------------------------------------------------------------

/** Its name, and whether you still own it. Both belong to the catalog. */
export function Manage({ device }: { device: SavedDeviceView }) {
  const { rename, remove } = useDevices();
  const [name, setName] = useState(device.record.name);
  const [busy, setBusy] = useState(false);
  /**
   * Why the last thing you asked for did not happen.
   *
   * The provider's error state only reaches the banner when the *server* is
   * unreachable, which a refused rename is not. Without this a failure would
   * show nothing at all: the button stops spinning and the old name stays — and
   * for Forget, the user has already confirmed a warning saying the device is
   * about to be destroyed.
   */
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();

  const dirty = name.trim() !== device.record.name && name.trim().length > 0;

  const forget = () => {
    haptic();
    const message = `${device.record.name} and its recorded history will be removed. This cannot be undone.`;

    const proceed = () => {
      setBusy(true);
      setError(null);
      remove(device.id)
        .then(() => router.replace('/'))
        .catch((err: unknown) => {
          setError(describeError(err) || 'That device could not be forgotten');
        })
        .finally(() => setBusy(false));
    };

    if (Platform.OS === 'web') {
      // eslint-disable-next-line no-alert
      if (typeof confirm === 'function' && confirm(message)) proceed();
      return;
    }
    Alert.alert('Forget this device?', message, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: proceed },
    ]);
  };

  return (
    <YStack gap="$2">
      <SectionLabel>Manage</SectionLabel>
      <Card inset>
        <YStack padding="$4" gap="$2">
          <Text fontSize={15} fontWeight="600" color="$color">
            Name
          </Text>
          <XStack gap="$2">
            <Input
              flex={1}
              size="$3"
              value={name}
              maxLength={60}
              onChangeText={setName}
              backgroundColor="$background"
              borderColor="$borderColor"
            />
            {dirty ? (
              <Button
                size="$3"
                backgroundColor="$accent"
                color="$background"
                disabled={busy}
                onPress={() => {
                  haptic();
                  setBusy(true);
                  setError(null);
                  rename(device.id, name.trim())
                    .catch((err: unknown) => {
                      setError(describeError(err) || 'That name could not be saved');
                    })
                    .finally(() => setBusy(false));
                }}
              >
                Save
              </Button>
            ) : null}
          </XStack>
          {/*
            Only when there is a second name to contrast with. `device.name` is
            the catalog's — the very name in the box above — so without
            `providerName` this sentence would print it straight back.
          */}
          <Text fontSize={12} color="$muted" lineHeight={17}>
            {device.providerName
              ? `Yours, not the vendor’s. The device keeps reporting ${device.providerName}.`
              : 'Yours alone. Changing it later changes nothing but the label.'}
          </Text>
        </YStack>

        <RowSeparator />

        <Row
          title="Forget this device"
          subtitle="Removes it from the list, along with everything it has recorded"
          accessory={
            <Button
              size="$2"
              disabled={busy}
              borderColor="$danger"
              icon={<Feather name="trash-2" size={13} color={theme.danger?.val} />}
              onPress={forget}
            >
              Forget
            </Button>
          }
        />
      </Card>

      {error ? (
        <Text fontSize={12} color="$danger" lineHeight={18} paddingHorizontal="$1">
          {error}
        </Text>
      ) : null}
    </YStack>
  );
}
