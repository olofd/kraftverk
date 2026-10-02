import { useEffect, useState } from 'react';

import type { DeviceEventView, DeviceView } from '@kraftverk/api-client';
import { EventList } from '@kraftverk/ui';

import { useDevices } from '../../state/DevicesProvider';
import { useHome } from '../../state/HomeProvider';

/**
 * What it said happened, newest first — one part's, or all of them — read
 * again when the live stream carries one of its events. A device that
 * declares no events has nothing to show.
 */
export function Events({ device, part }: { device: DeviceView; part?: string }) {
  const { heard } = useDevices();
  const { api } = useHome();
  const [list, setList] = useState<DeviceEventView[] | null>(null);
  const count = heard?.deviceId === device.id ? heard.count : 0;
  const declares = (device.description.events?.length ?? 0) > 0;

  useEffect(() => {
    if (!declares) return;
    let live = true;
    void api.devices
      .events(device.id, 50)
      .then((events) => live && setList(events))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, count, declares, device.id]);

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
