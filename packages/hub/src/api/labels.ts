import { ApiError, type Caller, type KraftverkApi, type LabelInput, type LabelTarget } from '@kraftverk/api-contract';
import { automationId, savedDeviceId } from '@kraftverk/device-sdk';

import type { Hub } from '../node/hub.ts';
import { scopeOf } from './scope.ts';

/*
  A family's labels (docs/PLAN-WORLD-MODEL.md §8.13), as it answers them: any
  grouping it wants, put on devices, spaces and automations. On the timeline
  as the family's.
*/

const COLOR = /^#[0-9a-f]{6}$/;

/** A label given, checked: a refusal in words. */
function checkedLabel(input: Partial<LabelInput>): void {
  if (input.name !== undefined && !(input.name.trim().length >= 1 && input.name.trim().length <= 30)) throw new ApiError('invalid', 'A label’s name is 1 to 30 characters');
  if (input.color !== undefined && input.color !== null && !COLOR.test(input.color)) throw new ApiError('invalid', 'A colour is "#rrggbb", in lowercase');
}

/** The store's refusal, said as the family's. */
const refusing = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    throw error instanceof ApiError ? error : new ApiError('invalid', (error as Error).message);
  }
};

export function labelsApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'labels'> {
  const { record, changed } = scopeOf(hub, caller);
  const family = () => hub.family.get()!.id;
  const labelOf = (id: string) => {
    const label = hub.labels.get(id);
    if (!label) throw new ApiError('not-found', 'No such label');
    return label;
  };
  /** What a label is put on, there to be put on. */
  const there = (target: LabelTarget): string => {
    if ('device' in target) {
      const device = hub.catalog.active(savedDeviceId(target.device));
      if (!device) throw new ApiError('not-found', 'No such device');
      return device.name;
    }
    if ('space' in target) {
      const space = hub.spaces.space(target.space);
      if (!space || space.removedAt) throw new ApiError('not-found', 'No such space');
      return space.name;
    }
    const automation = hub.automations.get(automationId(target.automation));
    if (!automation) throw new ApiError('not-found', 'No such automation');
    return automation.name;
  };
  return {
    labels: {
      list: async () => hub.labels.list(),
      labelled: async () => hub.labels.labelled(),

      async add(input) {
        checkedLabel(input);
        const label = refusing(() => hub.labels.add({ ...input, name: input.name.trim() }));
        record('label.added', 'family', family(), `Added the label "${label.name}"`);
        return label;
      },

      async update(id, changes) {
        labelOf(id);
        checkedLabel(changes);
        const label = refusing(() => hub.labels.update(id, { ...changes, ...(changes.name !== undefined ? { name: changes.name.trim() } : {}) }))!;
        record('label.changed', 'family', family(), `Changed the label "${label.name}"`);
        changed();
        return label;
      },

      async remove(id) {
        const label = labelOf(id);
        hub.labels.remove(id);
        record('label.removed', 'family', family(), `Removed the label "${label.name}": it is off everything it was on`);
        changed();
      },

      async set(target, labelIds) {
        there(target);
        for (const id of labelIds) labelOf(id);
        hub.labels.set(target, labelIds);
        changed();
        return hub.labels.on(target);
      },
    },
  };
}
