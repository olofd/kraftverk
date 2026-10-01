import { attributeMeaning, unitOf, type DeviceDescription, type Rule } from '@kraftverk/device-sdk';

import type { AutomationEntry, Mode } from './document.ts';
import type { PrintContext } from './expr.ts';
import type { Use } from './rules.ts';

/*
  An automation as it lives — its rule, what fills each role by id, its mode
  as the engine says it — and as its entry in a file says it: each role by
  the key of what fills it, its mode in the file's words. Both ways, the same
  on the server, which exports and imports, and in the app, whose editor
  shows one as YAML and saves what is written there.
*/

/** How the engine says a mode. */
export type EngineMode = 'off' | 'observe' | 'armed';

/** A mode in the file's words, from the engine's. */
export const MODE_IN_FILE: Readonly<Record<EngineMode, Mode>> = { off: 'off', observe: 'watch', armed: 'act' };

/** A mode in the engine's words, from the file's. */
export const MODE_OF_FILE: Readonly<Record<Mode, EngineMode>> = { off: 'off', watch: 'observe', act: 'armed' };

/** An automation as it lives: what the server keeps, and the app is shown. */
export type AutomationSource = {
  name: string;
  mode: EngineMode;
  timeZone: string;
  recheckMinutes: number | null;
  homePlace: number | null;
  madeFrom: string | null;
  rule: Rule;
  /** What fills each part role: a device by its id, and which of its parts. */
  roles: Readonly<Record<string, { device: string; part: string }>>;
  /** What fills each automation role: an automation by its id. */
  starts: Readonly<Record<string, string>>;
};

/**
 * An automation as its entry: each role by the key of what fills it. A role
 * whose device or automation has gone is left unfilled — written as such —
 * and said, by role, in `gone`.
 */
export function automationEntryFrom(source: AutomationSource, keyOf: { device: (id: string) => string | null; automation: (id: string) => string | null }): { entry: AutomationEntry; gone: string[] } {
  const uses: Record<string, Use> = {};
  const gone: string[] = [];
  for (const [role, binding] of Object.entries(source.roles)) {
    const key = keyOf.device(binding.device);
    if (key) uses[role] = { device: key, part: binding.part };
    else gone.push(role);
  }
  for (const [role, id] of Object.entries(source.starts)) {
    const key = keyOf.automation(id);
    if (key) uses[role] = { automation: key };
    else gone.push(role);
  }
  return {
    entry: {
      name: source.name,
      mode: MODE_IN_FILE[source.mode],
      clock: source.timeZone,
      recheckMinutes: source.recheckMinutes,
      homePlace: source.homePlace,
      madeFrom: source.madeFrom,
      uses,
      rule: source.rule,
    },
    gone,
  };
}

/**
 * What fills each role, by id, from an entry's keys: each part role's device
 * and part, each automation role's automation — and, by role, each key that
 * names nothing here.
 */
export function fillsFrom(
  uses: Readonly<Record<string, Use>>,
  idOf: { device: (key: string) => string | null; automation: (key: string) => string | null }
): { roles: Record<string, { device: string; part: string }>; starts: Record<string, string>; missing: { role: string; key: string }[] } {
  const roles: Record<string, { device: string; part: string }> = {};
  const starts: Record<string, string> = {};
  const missing: { role: string; key: string }[] = [];
  for (const [role, use] of Object.entries(uses)) {
    if ('automation' in use) {
      const id = idOf.automation(use.automation);
      if (id) starts[role] = id;
      else missing.push({ role, key: use.automation });
      continue;
    }
    const id = idOf.device(use.device);
    if (id) roles[role] = { device: id, part: use.part };
    else missing.push({ role, key: use.device });
  }
  return { roles, starts, missing };
}

/**
 * How numbers beside a role's readings are written: in the unit of what the
 * part filling it reports — `charger.power.draw > 50 W`.
 */
export function unitsFrom(roles: Readonly<Record<string, { device: string; part: string }>>, describe: (device: string) => DeviceDescription | null): PrintContext {
  return {
    unitOf: (role, means) => {
      const binding = roles[role];
      const description = binding ? describe(binding.device) : null;
      const attribute = description ? attributeMeaning(description, binding!.part, means) : null;
      return attribute ? unitOf(attribute) || null : null;
    },
  };
}
