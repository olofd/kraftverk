import { Feather } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { Card, Row, SectionLabel } from '@kraftverk/ui';
import { Text, useTheme, XStack, YStack } from 'tamagui';

import type { DeviceView } from '@kraftverk/api-client';

import { getApiBaseUrl } from '@kraftverk/api-client';

import { DeviceShell } from '../../../src/features/devices/DeviceShell';
import { useDeviceConnection } from '../../../src/features/devices/connection';
import { GenericSettings, Manage } from '../../../src/features/devices/panels';
import { screensFor } from '../../../src/devices/screens';
import { useDevices } from '../../../src/state/DevicesProvider';

/**
 * What this device remembers, and what you may change.
 *
 * Three things live here, in the order they matter: the device's own settings,
 * whatever advanced tools its model offers, and the catalog's business — its
 * name, and whether you still own it.
 *
 * The register diagnostics used to be a global tab called Protocol. They are a
 * P280 tool for one P280, so they sit behind Advanced on that device's own
 * settings screen. A plug will never show them, and does not have to say why.
 */
export default function DeviceSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { editable } = useDevices();

  return (
    <DeviceShell id={id} tab="settings">
      {(device) => (
        <>
          <WhereWritesGo device={device} />
          <Settings device={device} />
          <Advanced device={device} />
          {editable ? <Manage device={device} /> : null}
        </>
      )}
    </DeviceShell>
  );
}

/**
 * Where the values on this screen actually go.
 *
 * Every control below writes to real hardware — or to a simulator, or to
 * nothing at all in read-only mode — and which of the three it is changes what
 * a tap means. The old global Settings tab said so in its subtitle and the
 * device-scoped one lost it, on a device where one wrong register permanently
 * bricks the machine. It is one line, and it is worth the space.
 */
function WhereWritesGo({ device }: { device: DeviceView }) {
  const { status, readOnly, simulated, direct } = useDeviceConnection(device);
  const theme = useTheme();

  if (!status) return null;

  const [tone, icon, message] = readOnly
    ? (['$warning', 'lock', 'Read-only. Nothing on this screen will reach the station.'] as const)
    : simulated
      ? (['$muted', 'cpu', 'Simulator — changes here affect a fake station, not hardware.'] as const)
      : ([
          '$muted',
          direct ? 'bluetooth' : 'server',
          `Written straight to ${device.record.name} over ${direct ? 'Bluetooth' : 'the server'}.`,
        ] as const);

  return (
    <XStack alignItems="center" gap="$2.5" paddingHorizontal="$1">
      <Feather name={icon} size={13} color={theme[tone]?.val ?? theme.muted?.val} />
      <Text fontSize={12} color={tone} lineHeight={17} flex={1}>
        {message}
      </Text>
    </XStack>
  );
}

function Settings({ device }: { device: DeviceView }) {
  const connection = useDeviceConnection(device);

  const screens = screensFor(device);
  // No model panel, or nothing answering yet: the generic form is drawn from
  // the schema the device publishes, and works for anything.
  if (!screens || !connection.status) return <GenericSettings device={device} />;

  const Panel = screens.settings;

  return (
    <Panel
      status={connection.status}
      settings={connection.settings}
      readOnly={connection.readOnly}
      simulated={connection.simulated}
      direct={connection.direct}
      apiBaseUrl={getApiBaseUrl()}
      updateSettings={connection.updateSettings}
      togglePort={connection.togglePort}
    />
  );
}

/** Model-specific tools, for the models that have any. */
function Advanced({ device }: { device: DeviceView }) {
  const theme = useTheme();
  const screens = screensFor(device);
  if (!screens?.protocol) return null;

  return (
    <YStack gap="$2">
      <SectionLabel>Advanced</SectionLabel>
      <Card inset>
        <XStack
          cursor="pointer"
          pressStyle={{ opacity: 0.6 }}
          onPress={() => router.push(`/device/${encodeURIComponent(device.id)}/advanced`)}
        >
          <YStack flex={1}>
            <Row
              title="Protocol"
              subtitle="Register dumps and the snapshot-and-diff workflow, for verifying the map against real hardware"
              accessory={<Feather name="chevron-right" size={16} color={theme.muted?.val} />}
            />
          </YStack>
        </XStack>
      </Card>
    </YStack>
  );
}
