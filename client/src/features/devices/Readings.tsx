import { router } from 'expo-router';
import { useTheme } from 'tamagui';

import { fedBy, feedsTo, type DeviceView } from '@kraftverk/api-client';
import { attributesOf, MAIN_PART, partsOf } from '@kraftverk/device-sdk';
import { DeviceCard, EnergyFlow, Icon, PartCard, Row } from '@kraftverk/ui';

import { Pressable } from '../../components/Pressable';
import { useDevices } from '../../state/DevicesProvider';
import { DeviceIcon } from './DeviceIcon';
import { partSlotFor } from './registry';

export function Overview({ device }: { device: DeviceView }) {
  return (
    <DeviceCard
      device={{ name: device.name, subtitle: device.meta.name, health: device.health, attributes: attributesOf(device.description, MAIN_PART), readings: device.readings }}
      icon={<DeviceIcon device={device} />}
    />
  );
}

// --- readings -----------------------------------------------------------------

/** What a part reports: its attributes that are not only told — settings apart. */
export const reportedBy = (device: DeviceView, part: string) => attributesOf(device.description, part).filter((attribute) => attribute.access !== 'write');

/** Everything its main part reports, and what it last said. */
export function Readings({ device }: { device: DeviceView }) {
  return <PartCard title="Readings" attributes={reportedBy(device, MAIN_PART)} readings={device.readings} />;
}

/**
 * Each of its other parts as a card — or as its package draws it, where it
 * fills that part's slot — with the way to the part's own page: a strip with
 * six sockets, a station with four packs.
 */
export function Parts({ device }: { device: DeviceView }) {
  const { screenProps } = useDevices();
  const theme = useTheme();
  const parts = partsOf(device.description, device.name).filter((part) => part.id !== MAIN_PART);
  return (
    <>
      {parts.map((part) => {
        const Slot = partSlotFor(device, part);
        if (Slot) return <Slot key={part.id} {...screenProps(device)} part={part} />;
        return (
          <PartCard
            key={part.id}
            title={part.label}
            attributes={reportedBy(device, part.id)}
            readings={device.readings}
            accessory={
              <Pressable onPress={() => router.push(`/device/${encodeURIComponent(device.id)}/part/${encodeURIComponent(part.id)}`)}>
                <Row title={`More about ${part.label.toLowerCase()}`} accessory={<Icon name="chevron-right" size={16} color={theme.muted?.val} />} />
              </Pressable>
            }
          />
        );
      })}
    </>
  );
}

/** Where its energy comes from, is kept and goes, for a device whose parts say — with what feeds each input, from the house's links. */
export function Energy({ device }: { device: DeviceView }) {
  return <EnergyFlow description={device.description} readings={device.readings} mainLabel={device.name} fedBy={fedBy(device.links)} feeds={feedsTo(device.links)} />;
}
