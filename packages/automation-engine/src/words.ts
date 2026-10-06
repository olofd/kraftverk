import { bindingsOf, ruleCommands, type Rule } from '@kraftverk/automation';

import type { AutomationRecord } from './model.ts';

/* How the engine says what runs did, in sentences a person reads on a card and the timeline. */

/** The device a run is about on the timeline: the one its first command acts on — a group's first part. */
export const actsOn = (automation: AutomationRecord, rule: Rule): string | undefined => {
  const first = ruleCommands(rule)[0];
  return first ? bindingsOf(automation, first.role)[0]?.device : undefined;
};

export const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
/** The steps that do something to the world — what a run's summary says it did. */
export const ACTS: ReadonlySet<string> = new Set(['command', 'write', 'start']);
/** An automation as a step names it: “Charge the scooter” — or one that is gone. */
export const quoted = (name: string | null): string => (name === null ? 'an automation you no longer have' : `“${name}”`);
/** A step as done: "Turned Heater plug off", "Set Scooter plug’s Live readings to on", "Started “Charge the scooter”"; anything else, "Sent …". */
export const pastOf = (what: string) =>
  /^turn /i.test(what) ? `Turned ${what.slice(5)}` : /^set /i.test(what) ? `Set ${what.slice(4)}` : /^start /i.test(what) ? `Started ${what.slice(6).replace(/ and wait until it ends.*$/, '')}` : `Sent ${lowerFirst(what)}`;
