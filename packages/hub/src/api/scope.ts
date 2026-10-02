import { ApiError, type Caller } from '@kraftverk/api-contract';
import { KEY, savedDeviceId, type ResourceKind, type SavedDeviceId } from '@kraftverk/device-sdk';
import type { DeviceRecord } from '@kraftverk/store';

import type { Hub } from '../node/hub.ts';
import { actorOf } from './caller.ts';

/**
 * Refuses a name in configuration that is not one, or is another's: what a
 * device and an automation are renamed to is checked by one rule, saying it
 * with an example of their own ("garage-station", "start-charging").
 */
export function checkKey(key: string, taken: boolean, what: 'device' | 'automation', example: string): void {
  if (!KEY.test(key)) throw new ApiError('invalid', `A key is lowercase letters, digits and dashes: "${example}"`);
  if (taken) throw new ApiError('conflict', `Another ${what} is known by "${key}"`);
}

/**
 * What the device parts of the API ask of the home for one caller: who acts,
 * the timeline as them, saying a list changed — and the device, its view or
 * a connection of it that a call names, or a refusal.
 */
export function scopeOf(hub: Hub, caller: Caller) {
  const actor = actorOf(caller);

  /** What happened, on the timeline, as this caller did it. */
  const record = (kind: string, resourceKind: ResourceKind, resource: string, summary: string, detail?: unknown) =>
    hub.audit.record({ at: new Date().toISOString(), kind, actor, resourceKind, resource, summary, detail });
  /** What a list of devices shows changed: every open screen reads it again. */
  const changed = () => hub.bus.publish({ kind: 'changed', deviceId: null });

  /**
   * The device asked for, or no such device. There is no inference, not even
   * "when there is only one": a guess right while you own one device is wrong,
   * silently, the day you own two.
   */
  const deviceOf = (id: string, { removed = false } = {}): DeviceRecord => {
    const found = removed ? hub.catalog.get(savedDeviceId(id)) : hub.catalog.active(savedDeviceId(id));
    if (!found) throw new ApiError('not-found', 'No such device');
    return found;
  };
  const viewOf = (id: SavedDeviceId) => {
    const view = hub.views.find(id);
    if (!view) throw new ApiError('not-found', 'No such device');
    return view;
  };
  const connectionOf = (deviceId: string, connectionId: string) => {
    const device = deviceOf(deviceId);
    const connection = hub.connections.get(connectionId);
    if (!connection || connection.deviceId !== device.id) throw new ApiError('not-found', 'No such connection');
    return { device, connection };
  };

  return { actor, record, changed, deviceOf, viewOf, connectionOf };
}
