import { ApiError, type Caller, type KraftverkApi, type PolicyValueView } from '@kraftverk/api-contract';
import { isPolicyValueName, POLICY_VALUES, type CapabilitySpec, type PolicyValueName } from '@kraftverk/device-sdk';

import { vocabularyOf, worldOf } from '../assistant/world.ts';
import type { Hub } from '../hub.ts';
import { actorOf } from './caller.ts';

/*
  The home as a whole, as everything that uses it asks: its configuration as
  one file, the values it sets that declarations name, its timeline, and the
  world as a model reads it, with the words it is said in.
*/

type HomeWideApi = Pick<KraftverkApi, 'configuration' | 'policy' | 'timeline' | 'world' | 'vocabulary'>;

export function homeWideApi(hub: Hub, caller: Caller): HomeWideApi {
  const actor = actorOf(caller);

  /** What this home decides that declarations name, each with its bounds and what it is now. */
  const policyView = (): PolicyValueView[] => {
    const set = hub.policy.values();
    return Object.entries(POLICY_VALUES).map(([name, spec]) => ({ name: name as PolicyValueName, ...spec, value: set[name as PolicyValueName] ?? spec.default }));
  };

  return {
    configuration: {
      vocabulary: async () => hub.configuration.vocabulary(),
      schema: async () => hub.configuration.schema(),
      export: (request, options) => hub.configuration.export(request, actor, options),
      plan: (request) => hub.configuration.plan(request.text, { mode: request.mode ?? 'merge', passphrase: request.passphrase }, actor),
      apply: (answers) => hub.configuration.apply(answers, actor),
    },

    policy: {
      list: async () => policyView(),

      async set(name, value) {
        if (!isPolicyValueName(name)) throw new ApiError('not-found', `There is no policy value "${name}"`);
        const spec = POLICY_VALUES[name];
        try {
          hub.policy.set(name, value);
        } catch (error) {
          throw new ApiError('invalid', (error as Error).message);
        }
        const now = value ?? spec.default;
        hub.audit.record({ at: new Date().toISOString(), kind: 'policy.changed', actor, summary: `${spec.label}: now ${now} ${spec.unit}${value === null ? ', the default' : ''}`, detail: { name, value } });
        return policyView();
      },
    },

    timeline: async (query = {}) => hub.audit.recent(query),

    /** The house now: every device, its parts, what each offers and reports and how fresh, and the links. */
    world: async () => worldOf(hub.registry.all(), { readOnly: hub.readOnly() }),

    /** The words the world is said in: capabilities — the library's and the devices' own — meanings, link kinds, recipes, and the values the home has set. */
    vocabulary: async () =>
      vocabularyOf(
        hub.library,
        hub.policy.values(),
        hub.registry.all().map((device) => (device.description.capabilities ?? {}) as Record<string, CapabilitySpec>)
      ),
  };
}
