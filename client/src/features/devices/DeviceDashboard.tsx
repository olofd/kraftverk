import { useLocalSearchParams } from 'expo-router';

import type { DeviceView } from '@kraftverk/api-client';

import { useDevices } from '../../state/DevicesProvider';
import { DeviceAutomations } from '../automations/DeviceAutomations';
import { Controls } from './Controls';
import { DeviceShell } from './DeviceShell';
import { Events } from './Events';
import { History } from './History';
import { Energy, Overview, Parts, Readings } from './Readings';
import { screensFor } from './registry';
import { RemovedDevice } from './RemovedDevice';

/**
 * What this device is doing.
 *
 * Drawn from its description: an overview, where its energy comes from and
 * goes, the controls its parts take, each part's card, its history and what it
 * said happened. A package deepens what it draws better — the whole top of the
 * dashboard (a station's own energy flow), or one part's card — and inherits
 * the rest; history and events are the app's for every device alike. Adding a
 * plug never requires writing a screen.
 */
export function DeviceDashboard() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DeviceShell id={id} tab="dashboard">{(device) => <Dashboard device={device} />}</DeviceShell>;
}

function Dashboard({ device }: { device: DeviceView }) {
  const { screenProps } = useDevices();
  if (device.removedAt) return <RemovedDevice device={device} />;

  const Panel = screensFor(device)?.dashboard;
  return (
    <>
      {Panel ? (
        <Panel {...screenProps(device)} />
      ) : (
        <>
          <Overview device={device} />
          <Energy device={device} />
          <Controls device={device} />
          <Readings device={device} />
          <Parts device={device} />
        </>
      )}
      <History device={device} />
      <Events device={device} />
      {/* At the bottom, for every device alike: the automations it takes part in, and a new one made from here. */}
      <DeviceAutomations device={device} />
    </>
  );
}
