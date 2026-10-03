
import type { DeviceView } from '@kraftverk/api-client';
import { EventList } from '@kraftverk/ui';

import { useAnswer } from '../../components/useAnswer';
import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';

/**
 * What it said happened, newest first — one part's, or all of them — read
 * again when the live stream carries one of its events. A device that
 * declares no events has nothing to show.
 */
/** How many of what it said happened are shown, newest first. */
const EVENTS_SHOWN = 50;

export function Events({ device, part }: { device: DeviceView; part?: string }) {
  const { heard } = useDevices();
  const { api } = useHome();
  const count = heard.byDevice[device.id] ?? 0;
  const declares = (device.description.events?.length ?? 0) > 0;

  const { value: list } = useAnswer(() => api.devices.events(device.id, EVENTS_SHOWN), [api, count, device.id], { when: declares });

  if (!declares || !list) return null;
  const shown = part === undefined ? list : list.filter((event) => event.part === part);
  return (
    <EventList
      title="What it said"
      events={shown.map((event) => ({ key: event.id, event: event.event, level: event.level, part: event.part, at: event.at }))}
      describe={() => device.description}
      empty="Nothing yet: what it says happened is listed here."
    />
  );
}
