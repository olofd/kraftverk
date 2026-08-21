import { Feather } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { Text, useTheme } from 'tamagui';

import { Card } from '@kraftverk/ui';
import { getApiBaseUrl } from '@kraftverk/api-client';
import type { SavedDeviceView } from '@kraftverk/api-client';

import { DeviceShell } from '../../../src/features/devices/DeviceShell';
import { useDeviceConnection } from '../../../src/features/devices/connection';
import { Controls, History, Overview, Readings } from '../../../src/features/devices/panels';
import { screensFor } from '../../../src/devices/screens';
import { useDirectLink } from '../../../src/state/DirectLinkProvider';

/**
 * What this device is doing.
 *
 * This used to be the app's first tab, which said the station *was* the
 * application. It is now one device's dashboard, reached from the canvas of
 * things you own — and the P280's energy-flow view is drawn by the P280's own
 * package rather than by the shell.
 *
 * A device with no screens of its own is not a lesser device: it gets the
 * generic panels, which is the outcome the device model exists for. If adding a
 * plug ever required writing a screen, the abstraction would not be working.
 */
export default function DeviceDashboardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return (
    <DeviceShell id={id} tab="dashboard">
      {(device) => <Dashboard device={device} />}
    </DeviceShell>
  );
}

function Dashboard({ device }: { device: SavedDeviceView }) {
  const connection = useDeviceConnection(device);
  const { direct } = useDirectLink();

  const screens = screensFor(device);

  if (!screens) {
    return (
      <>
        <Overview device={device} />
        <Controls device={device} />
        <History device={device} />
        <Readings device={device} />
      </>
    );
  }

  /*
    The server knows why it is not holding a link to this device — it is the
    only station a one-radio process can serve, or its transport never started.
    Handing the model panel a null status instead would spin "Connecting…" at a
    server that is answering perfectly well and has already given its reason.
  */
  if (!connection.status && connection.reason) {
    return (
      <>
        <Overview device={device} />
        <NotConnected reason={connection.reason} />
      </>
    );
  }

  const Panel = screens.dashboard;

  return (
    <>
      <Panel
        status={connection.status}
        settings={connection.settings}
        version={connection.version}
        readOnly={connection.readOnly}
        simulated={connection.simulated}
        direct={connection.direct}
        resuming={direct.resuming}
        linkLabel={connection.direct ? direct.support.label : undefined}
        apiBaseUrl={getApiBaseUrl()}
        updateSettings={connection.updateSettings}
        togglePort={connection.togglePort}
      />
      {/*
        History is the shell's, not the model's: it is drawn from whatever the
        device declared it measures, so every device gets the same charts for
        free and none of them has to draw them.
      */}
      <History device={device} />
    </>
  );
}

/** Why this device is not answering, in the server's own words. */
function NotConnected({ reason }: { reason: string }) {
  const theme = useTheme();

  return (
    <Card alignItems="center" paddingVertical="$7" gap="$3">
      <Feather name="link-2" size={20} color={theme.muted?.val} />
      <Text fontSize={13} color="$muted" textAlign="center" lineHeight={19} maxWidth={360}>
        {reason}
      </Text>
    </Card>
  );
}
