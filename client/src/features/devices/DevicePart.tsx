import { useLocalSearchParams } from 'expo-router';
import { Text } from 'tamagui';

import { partsOf } from '@kraftverk/device-sdk';
import { Card, PartCard } from '@kraftverk/ui';

import { Screen } from '../../components/Screen';
import { useDevice, useDevices } from '../../state/DevicesProvider';
import { Controls } from './Controls';
import { deviceStatus } from './DeviceShell';
import { Events } from './Events';
import { History } from './History';
import { reportedBy } from './Readings';
import { partSlotFor } from './registry';

/**
 * One part of a device, on a page of its own: what it reports, what it takes,
 * its history and what it said happened — a pack's charge over a month, one
 * socket of six. Drawn from the description like the rest; a package that
 * draws the part's card itself draws it here too.
 */
export function DevicePart() {
  const { id, part: partId } = useLocalSearchParams<{ id: string; part: string }>();
  const device = useDevice(id);
  const { screenProps } = useDevices();
  const devicePath = device ? `/device/${encodeURIComponent(device.id)}` : '/';
  const part = device ? partsOf(device.description, device.name).find((candidate) => candidate.id === partId) : undefined;

  if (!device || !part) {
    return (
      <Screen back={device?.name ?? 'Your devices'} backTo={devicePath} title="Part">
        <Card padding="$4">
          <Text fontSize={13} color="$muted" lineHeight={19}>
            {device ? `${device.name} has no part "${partId}" now.` : 'That device is no longer in the list.'}
          </Text>
        </Card>
      </Screen>
    );
  }

  const Slot = partSlotFor(device, part);
  return (
    <Screen back={device.name} backTo={devicePath} title={part.label} subtitle={device.name} status={deviceStatus(device)}>
      {Slot ? (
        <Slot {...screenProps(device)} part={part} />
      ) : (
        <PartCard title="Readings" attributes={reportedBy(device, part.id)} readings={device.readings} />
      )}
      <Controls device={device} part={part.id} />
      <History device={device} part={part.id} />
      <Events device={device} part={part.id} />
    </Screen>
  );
}
