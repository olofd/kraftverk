import { useLocalSearchParams } from 'expo-router';

import type { DeviceView } from '@kraftverk/api-client';

import { DeviceShell } from '../../../src/features/devices/DeviceShell';
import { Controls, History, Overview, Readings } from '../../../src/features/devices/panels';
import { RemovedDevice } from '../../../src/features/devices/removed';
import { screensFor } from '../../../src/devices/ui';
import { useDevices } from '../../../src/state/DevicesProvider';

/**
 * What this device is doing.
 *
 * A device with screens of its own — a station's energy flow — gets them, fed
 * through whoever holds its connection. Every other device gets the generic
 * panels, which is the outcome the device model exists for: adding a plug
 * must never require writing a screen.
 */
export default function DeviceDashboardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DeviceShell id={id} tab="dashboard">{(device) => <Dashboard device={device} />}</DeviceShell>;
}

function Dashboard({ device }: { device: DeviceView }) {
  const { screenProps } = useDevices();
  if (device.removedAt) return <RemovedDevice device={device} />;

  const Panel = screensFor(device)?.dashboard;
  if (!Panel) {
    return (
      <>
        <Overview device={device} />
        <Controls device={device} />
        <History device={device} />
        <Readings device={device} />
      </>
    );
  }
  return (
    <>
      <Panel {...screenProps(device)} />
      {/* History is the shell's: drawn from what the device declared, for every device alike. */}
      <History device={device} />
    </>
  );
}
