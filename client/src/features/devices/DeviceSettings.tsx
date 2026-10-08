import { useLocalSearchParams } from 'expo-router';

import type { DeviceView } from '@kraftverk/api-client';
import { InfoCard } from '@kraftverk/ui';

import { useDevices } from '../../state/DevicesProvider';
import { DeviceConfig } from '../config/DeviceConfig';
import { ChangeType } from './ChangeType';
import { Connections } from './Connections';
import { DeviceShell } from './DeviceShell';
import { GenericSettings } from './GenericSettings';
import { Links } from './Links';
import { Manage } from './Manage';
import { screensFor } from './registry';
import { RemovedDevice } from './RemovedDevice';
import { Tools } from './Tools';
import { WhereItIs } from './WhereItIs';
import { WhereWritesGo } from './WhereWritesGo';

/**
 * What this device remembers, how it is reached, how it fits the house, what
 * it is, and whether you still have it — in the order they matter.
 */
export function DeviceSettings() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <DeviceShell id={id} tab="settings">{(device) => (device.removedAt ? <RemovedDevice device={device} /> : <SettingsOf device={device} />)}</DeviceShell>;
}

function SettingsOf({ device }: { device: DeviceView }) {
  const { screenProps } = useDevices();
  const Panel = screensFor(device)?.settings;
  return (
    <>
      <WhereWritesGo device={device} />
      {Panel ? <Panel {...screenProps(device)} /> : <GenericSettings device={device} />}
      <WhereItIs device={device} />
      <Connections device={device} />
      <Links device={device} />
      <InfoCard info={device.info} />
      <Tools device={device} />
      <DeviceConfig device={device} />
      <ChangeType device={device} />
      <Manage device={device} />
    </>
  );
}
