import type { Rule } from '../rule.ts';
import type { KindDocs } from './spec.ts';

/*
  The parts of an automation as a configuration file writes them — what it
  uses, its settings, what it remembers, what starts it, what a start while
  it runs does, its condition, its steps and what it does if one fails —
  each described once, with whole examples: what the reference says of
  them, and what its tests read and check. A part of a rule with no page
  here does not compile.
*/

/** One part of a rule, as a file writes it: its key there, and its page. */
export type RulePartDocs = KindDocs & { key: string; label: string };

/** Every part of a rule, in the order a file writes them. */
export const RULE_PART_DOCS: { readonly [K in keyof Rule]-?: RulePartDocs } = {
  roles: {
    key: 'uses',
    label: 'What it uses',
    summary:
      'Each role, by the name its steps and conditions call it, and what fills it: a device by its key — `device-key.part` for one of its parts; a list of them for a group a `for each` goes through; or `{ automation: key }` for another automation a `start` step starts. What each role must offer is read from what is done with it; say it — `needs:` — or give it a label in the long form. `~` (or `[]` for a group): nothing fills it yet.',
    examples: [
      'uses:\n  supply: garage-station.outlet.ac\n  charger: charger-plug\ndo:\n  - turn on: supply\n  - wait until: charger reachable\n    at most: 2 min\n  - turn on: charger',
      'uses:\n  outlets: [smart-plug, garage-station.outlet.ac]\ndo:\n  - for each: outlet\n    in: outlets\n    do:\n      - turn off: outlet',
      'uses:\n  plug:\n    part: smart-plug\n    label: The kettle\n  morning:\n    automation: morning-charge\ndo:\n  - turn on: plug\n  - start: morning',
    ],
  },
  params: {
    key: 'settings',
    label: 'Its settings',
    summary:
      'Levels set once and read anywhere in it as `setting.name`: a value alone — `low: 20 %` — or, long, with its title, range and how the app sets it. A number keeps its unit; a length of time is kept in seconds whatever it is written in. A recipe’s copies start from its settings, for their owners to set.',
    examples: [
      'settings:\n  low: 20 %\n  lowFor:\n    title: For at least\n    value: 2 min\n    max: 1 h\nuses:\n  station: garage-station\n  charger: charger-plug\nwhen:\n  - becomes: station.charge < setting.low\n    for: setting.lowFor\ndo:\n  - turn on: charger',
      'settings:\n  mode:\n    title: Then\n    value: eco\n    options: { eco: Save power, boost: Charge fast }\nuses:\n  station: garage-station\n  charger: charger-plug\nwhen:\n  - becomes: station.charge < 50 %\ndo:\n  - if: setting.mode == "boost"\n    then:\n      - turn on: charger',
    ],
  },
  memory: {
    key: 'memory',
    label: 'What it remembers',
    summary:
      'Values kept across runs, restarts and changes to it — written as settings are, each the value it starts from; read as `memory.name`, set by a `remember` step, in its unit and held to its range.',
    examples: ['memory:\n  timesCharged: { value: 0, integer: true, min: 0 }\n  lastPower: 0 W\nuses:\n  charger: charger-plug\ndo:\n  - remember: timesCharged\n    as: memory.timesCharged + 1\n  - remember: lastPower\n    as: charger.power'],
  },
  when: {
    key: 'when',
    label: 'What starts it',
    summary: 'Its triggers: any one starts a run — a time of day, every so often, a condition becoming true, an event a device raises. None: it runs only when you, or another automation, start it.',
    examples: ['uses:\n  station: garage-station\n  charger: charger-plug\nwhen:\n  - at: "07:00"\n    days: weekdays\n  - becomes: station.charge < 15 %\n    for: 2 min\ndo:\n  - turn on: charger'],
  },
  whileRunning: {
    key: 'while running',
    label: 'Started again while it runs',
    summary: 'What one of its triggers starting it while a run still takes its steps does: `skip` — the start is let go, as when none is written; `restart` — the run is stopped, its `if a step fails` steps taken, and it starts afresh; `queue` — it starts again once the run ends, at most 10 waiting.',
    examples: ['while running: restart\nuses:\n  mains: garage-station.input.ac\n  light: hall-light\nwhen:\n  - event: mains.lost\n    from: mains\ndo:\n  - turn on: light\n  - wait: 5 min\n  - turn off: light'],
  },
  if: {
    key: 'only if',
    label: 'Only if',
    summary: 'A condition that must hold for a run to do anything, whatever started it. Unknown is not true: it does nothing, and says why.',
    examples: ['uses:\n  station: garage-station\n  charger: charger-plug\nwhen:\n  - at: "23:00"\nonly if: station.charge < 80 % and charger reachable\ndo:\n  - turn on: charger'],
  },
  then: {
    key: 'do',
    label: 'What it does',
    summary: 'Its steps, in order — each below. A trigger may have steps of its own instead (`do:` under it).',
    examples: ['uses:\n  charger: charger-plug\ndo:\n  - turn on: charger\n  - wait: 10 s\n  - make sure: charger.power > 50 W\n    within: 20 s\n    tries: 3\n    each time:\n      - turn off: charger\n      - wait: 5 s\n      - turn on: charger'],
  },
  otherwise: {
    key: 'if a step fails',
    label: 'If a step fails, or you stop it',
    summary: 'Steps taken when a step does not succeed, or a person stops the run: each tried, whatever the others do, and none that waits for what might not come.',
    examples: ['uses:\n  supply: garage-station.outlet.ac\n  charger: charger-plug\ndo:\n  - turn on: supply\n  - turn on: charger\n  - wait until: charger.power > 10 W\n    at most: 2 min\nif a step fails:\n  - turn off: charger\n  - turn off: supply'],
  },
};
