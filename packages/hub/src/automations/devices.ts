import type { RoleBinding } from '@kraftverk/api-contract';
import { capabilitiesOf, partName, partsOf } from '@kraftverk/device-sdk';
import type { EngineDevice } from '@kraftverk/automation-engine';
import { deviceReader } from '@kraftverk/holder';

import type { DeviceCatalog } from '@kraftverk/store';
import type { SessionManager } from '@kraftverk/holder';

/**
 * Parts of devices as a home holds them, for the engine: a removed device
 * is still found, so an automation can say it was removed rather than that it
 * never existed; one only an app holds has no session here, and says whose it
 * is. A part is named with its device: "Garage station — AC outlets".
 */
export const homeDevices =
  (catalog: Pick<DeviceCatalog, 'get'>, sessions: Pick<SessionManager, 'get' | 'health' | 'description'>) =>
  (binding: RoleBinding): EngineDevice | null => {
    const record = catalog.get(binding.device);
    if (!record) return null;
    const removed = record.removedAt !== null;
    const description = removed ? record.description : sessions.description(record);
    const part = partsOf(description, record.name).find((candidate) => candidate.id === binding.part) ?? null;
    const session = removed ? null : sessions.get(record.id);
    return {
      name: partName(record.name, binding.part, part?.label),
      deviceName: record.name,
      typeId: record.typeId,
      removed,
      hasPart: part !== null,
      part: binding.part,
      description,
      // What a function may see: readings, health and checked queries — never the session itself.
      device: session ? deviceReader(session, () => sessions.description(record)) : null,
      offline: removed ? 'It has been removed' : sessions.health(record).detail,
      capabilities: part ? capabilitiesOf(description, part.id) : [],
      reachable: () => {
        if (removed) return { reachable: false, detail: 'It has been removed' };
        const health = sessions.health(record);
        return { reachable: health.status === 'connected', detail: health.detail };
      },
      wantFresh: (until) => sessions.get(record.id)?.wantFresh?.(until),
    };
  };
