import { useCallback, useEffect, useState } from 'react';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button, Input, Spinner, Text, useTheme, XStack, YStack } from 'tamagui';

import { describeError } from '@kraftverk/api-client';
import type { DeviceModelOption, DeviceTypeOption } from '@kraftverk/api-client';
import { Card, Row, RowSeparator, SectionLabel, haptic } from '@kraftverk/ui';

import { Screen } from '../src/components/Screen';
import { featherName } from '../src/lib/icons';
import { useDevices } from '../src/state/DevicesProvider';

/**
 * Adding a device.
 *
 * The list of what can be added comes from the server, which builds it from the
 * core's own device types plus whatever the installed extensions provide. So a
 * driver installed next week appears here without this screen changing — the
 * whole point of the exercise, and the thing that would be quietly untrue if
 * this file contained a list of its own.
 *
 * How a driver *reaches* its device — addresses, keys, pairing — is the
 * extension's business and is configured on the Extensions screen. What is
 * decided here is only what the core owns: that you have one, and what it is.
 */
export default function AddDeviceScreen() {
  const { types, add, devices } = useDevices();
  const theme = useTheme();

  const [options, setOptions] = useState<DeviceTypeOption[] | null>(null);
  const [chosen, setChosen] = useState<DeviceTypeOption | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void types()
      .then((loaded) => live && setOptions(loaded))
      .catch((err: unknown) => {
        if (live) setError(describeError(err) || 'Could not load what can be added');
      });
    return () => {
      live = false;
    };
  }, [types]);

  /** One station at a time: the driver holds a single link. */
  const stationTaken = devices.some((device) => device.record.type === 'power-station');

  const choose = useCallback((option: DeviceTypeOption) => {
    haptic();
    setChosen(option);
    setModel(option.models.find((candidate) => candidate.verified)?.id ?? option.models[0]?.id ?? null);
    setName(option.label);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const created = await add({
        type: chosen.id === 'power-station' ? 'power-station' : 'smart-plug',
        driver: chosen.driver,
        name: name.trim() || chosen.label,
        model,
      });
      router.replace(`/device/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setError(describeError(err) || 'That device could not be added');
      setBusy(false);
    }
  }, [add, chosen, model, name]);

  return (
    <Screen back="Your devices" title="Add a device" subtitle="What have you got?">
      {error ? (
        <Card borderColor="$danger">
          <Text fontSize={13} color="$danger" lineHeight={19}>
            {error}
          </Text>
        </Card>
      ) : null}

      {options === null ? (
        <Card>
          <YStack padding="$5" alignItems="center">
            <Spinner color="$accent" />
          </YStack>
        </Card>
      ) : (
        <YStack gap="$2">
          <SectionLabel>Type</SectionLabel>
          <Card inset>
            {options.map((option, index) => {
              const blocked = option.id === 'power-station' && stationTaken;
              const active = chosen?.id === option.id;

              return (
                <YStack key={option.id}>
                  {index > 0 ? <RowSeparator /> : null}
                  <XStack
                    opacity={blocked ? 0.45 : 1}
                    cursor={blocked ? undefined : 'pointer'}
                    pressStyle={blocked ? undefined : { opacity: 0.6 }}
                    onPress={blocked ? undefined : () => choose(option)}
                  >
                    <YStack flex={1}>
                      <Row
                        title={option.label}
                        subtitle={
                          blocked
                            ? 'Already added — the server holds one station link at a time'
                            : (option.note ?? option.description)
                        }
                        accessory={
                          <Feather
                            name={active ? 'check-circle' : featherName(option.icon)}
                            size={16}
                            color={active ? theme.accent?.val : theme.muted?.val}
                          />
                        }
                      />
                    </YStack>
                  </XStack>
                </YStack>
              );
            })}
          </Card>
        </YStack>
      )}

      {chosen?.id === 'power-station' ? <ConnectionOwner /> : null}

      {chosen ? (
        <>
          {chosen.models.length > 0 ? (
            <Models
              models={chosen.models}
              value={model}
              onChange={(next) => {
                haptic();
                setModel(next);
              }}
            />
          ) : null}

          <YStack gap="$2">
            <SectionLabel>Name</SectionLabel>
            <Card gap="$2">
              <Input
                size="$3"
                value={name}
                maxLength={60}
                placeholder={chosen.label}
                onChangeText={setName}
                backgroundColor="$background"
                borderColor="$borderColor"
              />
              <Text fontSize={12} color="$muted" lineHeight={17}>
                What you call it. Changing it later changes nothing but the label.
              </Text>
            </Card>
          </YStack>

          <Button
            size="$4"
            backgroundColor="$accent"
            color="$background"
            disabled={busy}
            onPress={() => {
              haptic();
              void submit();
            }}
          >
            {busy ? 'Adding…' : `Add ${name.trim() || chosen.label}`}
          </Button>

          {chosen.driver !== 'core.station' ? (
            <Text fontSize={12} color="$muted" lineHeight={18} paddingHorizontal="$1">
              How this driver reaches the device — its address and keys — is set up on the
              Extensions screen. Until that is done it will sit here greyed out, saying why.
            </Text>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

/**
 * Who will hold the link — and the honest admission that this screen only makes
 * one of the two.
 *
 * Adding a device here creates a **server-owned** station: the server holds the
 * link, which is what makes history, background sampling and automations
 * possible, because only the server is running when the app is closed.
 *
 * Driving a station straight from this browser or phone over Bluetooth is a
 * different kind of connection, and it does not need a saved device at all. It
 * is set up on the Station link screen. Saying so here is the difference between
 * a user who finds that screen and one who adds a station the server cannot
 * reach and is left with a permanently grey card.
 *
 * The wizard that offers both in one flow is Milestone B; until it exists, this
 * points at the screen that already works rather than pretending.
 */
function ConnectionOwner() {
  const theme = useTheme();

  return (
    <YStack gap="$2">
      <SectionLabel>Connection</SectionLabel>
      <Card gap="$3" alignItems="flex-start">
        <Text fontSize={13} color="$muted" lineHeight={19}>
          The <Text color="$color">server</Text> will hold this station's link, over WiFi or its
          own Bluetooth. That is what records history and can run automations while the app is
          closed.
        </Text>
        <Text fontSize={13} color="$muted" lineHeight={19}>
          To drive a station from <Text color="$color">this device</Text> over Bluetooth instead —
          live readings, settings and manual control while the app is open — you do not add it
          here. Set that up on the Station link screen.
        </Text>
        <Button
          size="$3"
          icon={<Feather name="bluetooth" size={14} color={theme.color?.val} />}
          onPress={() => {
            haptic();
            router.push('/link');
          }}
        >
          Connect over Bluetooth instead
        </Button>
      </Card>
    </YStack>
  );
}

/**
 * Which hardware it is, and how far each option is actually trusted.
 *
 * The register map was verified on one machine. Saying so at the point of
 * choosing is the difference between a user who knows their numbers are
 * approximate and one who finds out when the numbers look odd.
 */
function Models({
  models,
  value,
  onChange,
}: {
  models: DeviceModelOption[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  const theme = useTheme();

  return (
    <YStack gap="$2">
      <SectionLabel>Model</SectionLabel>
      <Card inset>
        {models.map((option, index) => (
          <YStack key={option.id}>
            {index > 0 ? <RowSeparator /> : null}
            <XStack cursor="pointer" pressStyle={{ opacity: 0.6 }} onPress={() => onChange(option.id)}>
              <YStack flex={1}>
                <Row
                  title={option.label}
                  subtitle={option.note}
                  accessory={
                    <XStack alignItems="center" gap="$2">
                      {option.verified ? (
                        <Feather name="check" size={13} color={theme.success?.val} />
                      ) : null}
                      <Feather
                        name={option.id === value ? 'disc' : 'circle'}
                        size={16}
                        color={option.id === value ? theme.accent?.val : theme.muted?.val}
                      />
                    </XStack>
                  }
                />
              </YStack>
            </XStack>
          </YStack>
        ))}
      </Card>
    </YStack>
  );
}
