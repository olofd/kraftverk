import { ApiError, type Caller, type KraftverkApi, type VariableView } from '@kraftverk/api-contract';
import { ruleUses, variableProblems, variableValueText, type VariableSpec } from '@kraftverk/automation';
import type { VariableRecord } from '@kraftverk/store';

import type { Hub } from '../node/hub.ts';
import { VariableRefusal } from '../variables/variables.ts';
import { actorOf } from './caller.ts';

/*
  A home's variables (docs/PLAN-VARIABLES-AND-TRIGGERS.md), as a family
  answers them: each declared by a person — its key, its kind, its field —
  and set by a person, a script or an automation, on the timeline as theirs.
  Each change is said on the bus, so what reads it looks again.
*/

/** A refusal from the controller, said as the family's; anything else is a fault, and stays one. */
const refusing = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    throw error instanceof VariableRefusal ? new ApiError(error.kind, error.message) : error;
  }
};

export function variablesApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'variables'> {
  const by = actorOf(caller);
  const now = () => new Date(hub.clock.now()).toISOString();
  const record = (kind: string, resource: string, summary: string) => hub.audit.record({ at: now(), kind, actor: by, resourceKind: 'variable', resource, summary });
  const homeOf = (id: string) => {
    const home = hub.places.home(id);
    if (!home || home.removedAt) throw new ApiError('not-found', 'No such home');
    return home;
  };
  const variableOf = (id: string) => {
    const variable = hub.variableStore.get(id);
    if (!variable || variable.removedAt) throw new ApiError('not-found', 'No such variable');
    return variable;
  };
  const byKey = (homeId: string, key: string) => {
    const variable = hub.variableStore.byKey(homeOf(homeId).id, key);
    if (!variable) throw new ApiError('not-found', `The home has no variable "${key}"`);
    return variable;
  };
  const viewOf = (variable: VariableRecord): VariableView => {
    const kept = variable.removedAt ? null : hub.variableStore.value(variable.id);
    return {
      id: variable.id,
      homeId: variable.homeId,
      key: variable.key,
      kind: variable.kind,
      field: variable.field,
      value: variable.removedAt ? null : hub.variables.now(variable.homeId, variable.key),
      setAt: kept?.setAt ?? null,
      by: kept?.by.name ?? null,
      removedAt: variable.removedAt,
    };
  };
  /** A variable as declared, checked: its key, its kind, its field, and the two fitting. */
  const declared = (input: VariableSpec) => {
    const problems = variableProblems(input);
    if (problems.length) throw new ApiError('invalid', problems.join('; '));
  };

  return {
    variables: {
      list: async (homeId, options = {}) => hub.variableStore.list(homeOf(homeId).id, options).map(viewOf),

      async add(homeId, input) {
        const home = homeOf(homeId);
        declared(input);
        if (hub.variableStore.byKey(home.id, input.key)) throw new ApiError('conflict', `${home.name} has a variable "${input.key}" already`);
        const variable = hub.variableStore.add(home.id, { key: input.key, kind: input.kind, field: input.field }, now());
        record('variable.added', variable.id, `Added the variable ${variable.field.title} to ${home.name}`);
        hub.variables.changed(home.id);
        return viewOf(variable);
      },

      async update(id, changes) {
        const was = variableOf(id);
        const next = { key: changes.key ?? was.key, kind: changes.kind ?? was.kind, field: changes.field ?? was.field };
        declared(next);
        if (next.key !== was.key) {
          if (hub.variableStore.byKey(was.homeId, next.key)) throw new ApiError('conflict', `The home has a variable "${next.key}" already`);
          // Rekeyed under an automation that names it, that automation would read nothing: changed there first.
          const using = hub.automations.list().filter((automation) => ruleUses(automation.rule).variables.some((each) => each.key === was.key));
          if (using.length) throw new ApiError('conflict', `${using.map((automation) => `“${automation.name}”`).join(', ')} ${using.length === 1 ? 'uses' : 'use'} "${was.key}": change ${using.length === 1 ? 'it' : 'them'} first`);
        }
        // What it held, no longer meaning the same, goes back to what it starts as — and is said so.
        const variable = hub.variables.redeclare(was, next, by);
        record('variable.changed', id, `Changed the variable ${variable.field.title}: ${Object.keys(changes).join(', ')}`);
        return viewOf(variable);
      },

      async remove(id) {
        const was = variableOf(id);
        const variable = hub.variableStore.remove(id, now())!;
        record('variable.removed', id, `Let the variable ${was.field.title} go`);
        hub.variables.changed(was.homeId);
        return viewOf(variable);
      },

      async set(homeId, key, value) {
        const variable = byKey(homeId, key);
        const set = refusing(() => hub.variables.set(variable.homeId, key, value, by));
        if (set.changed) record('variable.set', variable.id, `${variable.field.title} is ${variableValueText(variable, set.value)}, was ${variableValueText(variable, set.previous)}`);
        return viewOf(variable);
      },

      async count(homeId, key, count = {}) {
        const variable = byKey(homeId, key);
        const set = refusing(() => hub.variables.count(variable.homeId, key, count, by));
        if (set.changed) record('variable.set', variable.id, `${variable.field.title} is ${variableValueText(variable, set.value)}, was ${variableValueText(variable, set.previous)}`);
        return viewOf(variable);
      },
    },
  };
}

