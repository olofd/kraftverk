import { ApiError, type Caller, type KraftverkApi, type PolicyValueView } from '@kraftverk/api-contract';
import { isPolicyValueName, POLICY_VALUES, type PolicyValueName } from '@kraftverk/device-sdk';

import type { Hub } from '../node/hub.ts';
import { actorOf } from './caller.ts';

/*
  The home's configuration as one file (docs/CONFIG.md) — exported, planned,
  applied, and what a home kept beside it has — and the values it decides
  that declarations name, as everything that uses a home asks.
*/

export function configurationApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'configuration' | 'policy'> {
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
      /** A file; or, in an app's own home, the copy it kept of the server it used last. */
      async plan(request) {
        if (!('from' in request)) return hub.configuration.plan(request.text, { mode: request.mode ?? 'merge', passphrase: request.passphrase }, actor);
        if (request.from !== 'copy' || !hub.keeping) throw new ApiError('not-found', request.from === 'this-node' ? 'Only an app with a server moves its own home to it' : 'This home keeps no copy of a server’s to bring in');
        return hub.keeping.plan(request.mode ?? 'merge', actor);
      },
      apply: (answers) => (hub.keeping?.owns(answers.plan) ? hub.keeping.apply(answers, actor) : hub.configuration.apply(answers, actor)),
      /** What a home kept beside this one has, to bring in: in an app's own home, the copy of a server's. */
      elsewhere: async () => hub.keeping?.what() ?? null,
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
  };
}
