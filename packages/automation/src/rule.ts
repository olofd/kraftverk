import type { CapabilityName, CapabilityNeed, ConfigSchema, Unit, Value } from '@kraftverk/device-sdk';

import type { BuiltinName } from './kinds/builtins.ts';

import type { Weekday } from './clock.ts';

/**
 * Automations as data: the rule (docs/AUTOMATIONS.md).
 *
 * One small, typed language that a package's recipe, a person's editor, a DSL
 * and an AI all write, and one evaluator that runs it wherever it is held.
 * Its words are the device model's — capabilities, meanings, events,
 * commands — plus the functions packages contribute; it adds none of its own.
 * It can read, compare, and ask the gateway for commands: nothing else. So
 * whatever wrote a rule wrote data, and a rule can do no more than a person
 * could from a screen, after it has been seen watching and let act on purpose.
 *
 * This file is the language: expressions, triggers, steps, roles and the
 * rule itself. Its clock is `clock.ts`; checking it, `check.ts`; what it
 * reads and changes, `reads.ts`; evaluating it, `evaluate.ts`; saying it in
 * words, `describe.ts`; the functions packages bring, `functions.ts`.
 *
 * Pure: no platform built-in, so a holder in the app can run it too.
 */

export type CompareOp = 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne';

/** The ways of looking back at a reading (`HISTORY_FNS`, kinds/history.ts). */
export type HistoryFn = 'average' | 'lowest' | 'highest' | 'change' | 'ago';

/** When the sun crosses the horizon (`SUN_EVENTS`, sun.ts). */
export type SunEvent = 'sunrise' | 'sunset';

/** The ways a group's parts are taken together (`ACROSS_FNS`, kinds/across.ts). */
export type AcrossFn = 'all' | 'any' | 'count' | 'sum' | 'average' | 'lowest' | 'highest';

/** Every comparison. */
export const COMPARE_OPS: readonly CompareOp[] = ['lt', 'le', 'gt', 'ge', 'eq', 'ne'];

/** The comparisons of order: only numbers are above or below each other. */
export const ORDERED_OPS: readonly CompareOp[] = ['lt', 'le', 'gt', 'ge'];

/** Something that has a value when a rule runs, or is unknown (null). */
export type Expr =
  /**
   * A value as it is written — a number with the unit it was written in
   * (`2 kW`, `90 %`, `2 min`: units.ts), converted where it meets another of
   * its quantity; with none, in the unit of what it is beside.
   */
  | { value: Value; unit?: Unit }
  /** One of the rule's settings: `setting.low`. */
  | { param: string }
  /** What it remembers, as a run last left it — or as it starts: `memory.timesCharged`. */
  | { memory: string }
  /** What the part filling a role reports now, by meaning: `charge`, or a type's own `acme.minutesToFull`. */
  | { read: { role: string; means: string } }
  /**
   * A reading over the time just gone, from what the home kept of it: its
   * average, lowest, highest, how much it changed, or what it was then —
   * `average(station.charge, 1 h)`. `over`: a length of time, a number or a
   * setting. Unknown when nothing was kept for that time.
   */
  | { history: HistoryFn; of: { role: string; means: string }; over: Expr }
  /**
   * The time of day the sun rises or sets where the home is, on the
   * automation's clock — or so long before or after: `sunset`,
   * `30 min before sunset`. A time of day, as `07:00` is: what `at` and
   * `time between` take. Unknown where the home has no place, or on a day
   * the sun does not cross the horizon.
   */
  | { sun: SunEvent; offset?: { by: Expr; before: boolean } }
  /**
   * Something of each part of a group, taken together: whether it holds for
   * all of them, any, how many — or their sum, average, lowest or highest.
   * `of` is said of each part, called `as` within it as a role is:
   * `any(c in chargers: c.power > 10 W)`. Unknown while it is for a part,
   * unless one part settles it.
   */
  | { across: AcrossFn; as: string; group: string; of: Expr }
  /** A function a package contributes, over the part filling a role: `acme.weather.sunny(forecast, day = "tomorrow")`. */
  | { call: string; role: string; args?: Readonly<Record<string, Expr>> }
  /** One of the language's own functions (`BUILTINS`, kinds/builtins.ts): `round(x)`, `clamp(x, 0 W, 2 kW)`, `max(a, b, c)`. */
  | { apply: BuiltinName; args: readonly Expr[] }
  | { compare: CompareOp; left: Expr; right: Expr }
  /**
   * A number from two: their sum, difference, product or quotient. A sum is
   * in one unit, as a comparison is — "the charge limit, less 5 %"; a
   * product or quotient makes the unit the two make (units.ts): a power for
   * a time is an energy, a percentage a share. Unknown when either is.
   */
  | { math: MathOp; left: Expr; right: Expr }
  /** A number's opposite: `-x`. */
  | { negate: Expr }
  /** One value or another, as a condition is: `c ? a : b`. Unknown when the condition is. */
  | { if: Expr; then: Expr; else: Expr }
  /** The first of these that is known: `x ?? fallback` — a reading gone quiet, a default in its place. */
  | { either: readonly Expr[] }
  /** Whether a value is one of these: `station.mode in ["eco", "boost"]`. */
  | { item: Expr; in: readonly Expr[] }
  | { all: readonly Expr[] }
  | { any: readonly Expr[] }
  | { not: Expr }
  /**
   * Whether the part filling a role can be reached now: its holder says it is
   * connected. Never unknown — not being reachable is the answer.
   */
  | { reachable: string }
  /**
   * Whether the owner's clock is between two times of day, "HH:MM": from
   * `from`, up to but not at `to` — across midnight when `to` comes first
   * ("22:00" to "06:00" is the night). Unknown where there is no clock: a
   * rule's settings alone cannot say what time it is.
   */
  | { within: { from: Expr; to: Expr } }
  /**
   * A fact of the run itself, read as any value is (`RUN_FACTS`): `trigger`,
   * the id of the trigger that started it — so `run.trigger == "low"` turns
   * the plug on when `low` started it, and one automation does one thing
   * when a level is crossed one way and another the other way, each side
   * with its own level and hold, nothing said twice. `event`, the event
   * that started it — and, with `field`, what it carried: `run.event.voltage`.
   */
  | { run: RunFact; field?: string };

/**
 * What a run knows of itself, as values a rule reads: the language's own
 * namespace, `run.…`, beside the parts' readings and the rule's settings —
 * so what it gains later (who started it, which attempt) is a value like
 * these, not a construct of its own.
 *
 * - `trigger`: the id of the trigger that started it. A run played by hand,
 *   or started by another automation, counts as started by the first of its
 *   conditions that holds now — "do what you would do now". The empty text,
 *   `""`, when none with an id did: known, so a rule can tell.
 * - `event`: the id of the event a device raised that started it —
 *   `mains.lost` — and `event.<field>`, what it carried, as its device
 *   declares it: `run.event.voltage`. Unknown when no event started it.
 */
export const RUN_FACTS = ['trigger', 'event'] as const;

export type RunFact = (typeof RUN_FACTS)[number];

/** What `math` does with its two numbers. */
export type MathOp = 'add' | 'subtract' | 'multiply' | 'divide';

export const MATH_OPS: readonly MathOp[] = ['add', 'subtract', 'multiply', 'divide'];

/** Two numbers made one; unknown unless both are numbers — and a quotient by nothing is not one. */
export const calculate = (op: MathOp, left: Value, right: Value): Value => {
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  switch (op) {
    case 'add':
      return left + right;
    case 'subtract':
      return left - right;
    case 'multiply':
      return left * right;
    case 'divide':
      return right === 0 ? null : left / right;
  }
};

/**
 * What starts a run — each kind described once, in `kinds/triggers.ts`, which
 * everything that handles triggers reads. Lengths of time are in seconds.
 */
export type Trigger =
  /** At this time — "07:00" — on the automation's own clock: every day, or only on `days`. */
  | { at: Expr; days?: readonly Weekday[] }
  /**
   * Every so many seconds — whole minutes, 5 min to 12 h — on the owner's
   * clock from midnight: every 15 min is :00, :15, :30 and :45. Once a slot;
   * a server that was down runs once, at the latest, and does not catch up.
   * `if` narrows it: "every 15 minutes, between 22:00 and 06:00".
   */
  | { every: Expr }
  /** When the part filling a role raises an event its description declares. */
  | { event: { role: string; event: string } }
  /**
   * When a condition turns true — and, with `heldFor` (seconds), has stayed
   * true that long. Reads and comparisons only: it is evaluated on every reading.
   */
  | { becomes: Expr; heldFor?: Expr };

/**
 * A trigger as a rule holds it: its kind, and what every kind may have
 * besides (`TRIGGER_FIELDS`, kinds/triggers.ts) — `then`, steps of its own,
 * what a run it starts does in place of the rule's: "when the charge is
 * below 20 %, turn the charger on; when it is 40 %, turn it off", one
 * automation, each side said where it is. And `id`, a name of its own when
 * what a run does asks which one started it (`run.trigger`): `low`, `high`.
 * Unique within the rule.
 */
export type RuleTrigger = Trigger & {
  id?: string;
  /** A start it would make sooner than this after its last is let go: a door opened twice a minute turns the hall light on once in ten. Seconds, a number or a setting. */
  atMostEvery?: Expr;
  then?: readonly Step[];
};

/** A trigger's id: letters and digits, starting with a lowercase letter, as a role's name — `low`, `aboveHigh`. */
export const TRIGGER_ID = /^[a-z][a-zA-Z0-9]{0,31}$/;

// Any automation can be played by a person, or started by another: that is no trigger of its own (docs/AUTOMATION-EDITOR.md).

/** A capability command to the part filling a role. Only ever sent through the gateway. */
export type Command = { role: string; capability: CapabilityName; command: string; args: Readonly<Record<string, Expr>> };

/**
 * One step of what a rule does, in order (docs/SEQUENCES.md). A rule whose
 * steps are only commands does everything at once; one that waits takes as
 * long as its steps allow, and never longer: every wait has a limit, every
 * retry a count. Steps nest — a choice holds steps — to a few levels, so a
 * sequence still reads as a list a person can follow. Each kind is described
 * once, in `kinds/steps.ts`, which everything that handles steps reads.
 * Lengths of time are in seconds, named as a file says them: `for`,
 * `atMost`, `within`, `andWait`.
 */
export type Step =
  /** Through the gateway, as any command. */
  | { command: Command }
  /** A pause. */
  | { wait: { for: Expr } }
  /** Until a condition is true — or the run stops, not having succeeded, once it has waited that long. */
  | { waitUntil: { condition: Expr; atMost: Expr } }
  /**
   * Make sure a condition comes true within a time; if it does not, take the
   * `retry` steps and look again, at most `tries` times — then, still not, the
   * run stops, not having succeeded.
   */
  | { ensure: { condition: Expr; within: Expr; tries: Expr; retry: readonly Step[] } }
  /** One way or the other, as a condition is now. Unknown is not true: `else`. */
  | { choose: { if: Expr; then: readonly Step[]; else?: readonly Step[] } }
  /**
   * Watch a condition for a while: `then` if it stays true all that time,
   * `else` the moment it is not — or cannot be told. "Watch whether the
   * station's AC output stays below 10 W for 5 s: then switch it off."
   */
  | { watch: { condition: Expr; for: Expr; then?: readonly Step[]; else?: readonly Step[] } }
  /**
   * Change a setting the part filling a role offers — "switch the plug's live
   * readings on" — through the gateway, read back as any setting. Never one
   * its device declares dangerous.
   */
  | { write: Write }
  /**
   * Start the automation filling a role, as a person's play would — and, with
   * `andWait`, wait until its run ends: done if it acted, not if it did
   * not, or not within that time.
   */
  | { start: { role: string; andWait?: Expr } }
  /** Remember a value — kept until a run remembers another, across runs and restarts: `remember: timesCharged`, `as: memory.timesCharged + 1`. */
  | { remember: { name: string; value: Expr } }
  /**
   * Steps taken again and again: `times` rounds — or, with `until`, until it
   * is so after a round, at most that many: still not so after the last, it
   * does not succeed.
   */
  | { repeat: { times: Expr; until?: Expr; steps: readonly Step[] } }
  /**
   * Steps tried: one that does not succeed is the `recover` steps' to answer
   * — none, and it goes on as if it had — and the run goes on. A stop is not
   * caught.
   */
  | { try: { steps: readonly Step[]; recover?: readonly Step[] } }
  /** The run ends here, saying why: as it went — or, `failed`, as not having succeeded, its `if a step fails` steps taken. */
  | { stop: { why: string; failed?: boolean } }
  /** Until the part filling a role raises an event — or the run stops, not having succeeded, once it has waited that long. */
  | { waitFor: { role: string; event: string; atMost: Expr } }
  /**
   * The steps for each part of a group in turn — or, `together`, for every
   * one at the same time — the part called `as` within them, as a role is:
   * `for each: charger`, `in: chargers`, `do: [turn on: charger]`.
   */
  | { forEach: { as: string; in: string; together?: boolean; steps: readonly Step[] } };

/**
 * What one of its triggers starting it while it runs does: it is let go —
 * the run goes on; the run is stopped, as a person would, and it starts
 * afresh; or it starts once the run ends, at most `SEQUENCE_LIMITS.queued`
 * waiting. A person, or another automation, starting it while it runs is
 * told it is running, whichever.
 */
export type WhileRunning = 'skip' | 'restart' | 'queue';

/** Each way, as the editor offers it and the reference says it. */
export const WHILE_RUNNING: { readonly [W in WhileRunning]: { label: string; says: string } } = {
  skip: { label: 'Let it run', says: 'the run goes on, and the start is let go' },
  restart: { label: 'Start afresh', says: 'the run is stopped, and it starts again' },
  queue: { label: 'Start after it', says: 'it starts again once the run ends' },
};

export const isWhileRunning = (value: unknown): value is WhileRunning => typeof value === 'string' && Object.hasOwn(WHILE_RUNNING, value);

/** A role a part of a device fills: what it is called, and what it must offer. */
export type PartRole = CapabilityNeed & { label: string; group?: never; automation?: never };

/**
 * A role several parts fill — one or more, each offering what it needs —
 * named one at a time by a `for each`: "the chargers".
 */
export type GroupRole = CapabilityNeed & { label: string; group: true; automation?: never };

/** A role another automation fills: one a `start` step starts. */
export type AutomationRole = { automation: true; label: string; group?: never };

/** What fills a role — a part, several, or an automation — and what it is called. */
export type RoleSpec = PartRole | GroupRole | AutomationRole;

/**
 * A recipe's role: what it is, said for whoever fills it — "Anything that
 * reports its charge: a station, one of its packs". An automation made from
 * the recipe has its part, and needs no help choosing it: its roles are
 * `RoleSpec`s (`automationRoles`).
 */
export type RecipeRole = RoleSpec & { description: string };

/** What a role of each kind holds: what an automation keeps of one, and what a database's fingerprint carries. */
export const ROLE_FIELDS = { part: ['label', 'capabilities', 'oneOf'], group: ['group', 'label', 'capabilities', 'oneOf'], automation: ['automation', 'label'] } as const satisfies {
  part: readonly (keyof PartRole)[];
  group: readonly (keyof GroupRole)[];
  automation: readonly (keyof AutomationRole)[];
};

/** The kinds of role: one part, several, or another automation. */
export type RoleKind = keyof typeof ROLE_FIELDS;

/** Which kind of role it is. */
export const roleKind = (spec: RoleSpec): RoleKind => (isAutomationRole(spec) ? 'automation' : isGroupRole(spec) ? 'group' : 'part');

/** A rule's roles as an automation keeps them: its fields alone — what a recipe said for whoever fills them stays with the recipe. */
export const automationRoles = (roles: Readonly<Record<string, RoleSpec>>): Record<string, RoleSpec> =>
  Object.fromEntries(
    Object.entries(roles).map(([role, spec]) => {
      const fields: readonly string[] = ROLE_FIELDS[roleKind(spec)];
      return [role, Object.fromEntries(Object.entries(spec).filter(([field]) => fields.includes(field))) as RoleSpec];
    })
  );

export const isAutomationRole = (spec: RoleSpec): spec is AutomationRole => 'automation' in spec && spec.automation === true;

export const isGroupRole = (spec: RoleSpec): spec is GroupRole => 'group' in spec && spec.group === true;

/** The roles one part of a device fills each: what binding checks, and what a device's page lists. */
export const partRoles = (rule: Pick<Rule, 'roles'>): [string, PartRole][] =>
  Object.entries(rule.roles).filter((entry): entry is [string, PartRole] => !isAutomationRole(entry[1]) && !isGroupRole(entry[1]));

/** The roles several parts fill. */
export const groupRoles = (rule: Pick<Rule, 'roles'>): [string, GroupRole][] => Object.entries(rule.roles).filter((entry): entry is [string, GroupRole] => isGroupRole(entry[1]));

/** What each part of a group is, as the steps of a `for each` name it: a role of one part, asking what the group asks of each. */
export const memberRole = (group: GroupRole): PartRole => ({ label: group.label, capabilities: group.capabilities, ...(group.oneOf ? { oneOf: group.oneOf } : {}) });

export type Rule = {
  roles: Readonly<Record<string, RoleSpec>>;
  params: ConfigSchema;
  /**
   * What it remembers: each a field of a form — its kind, unit, range —
   * whose `default` is the value it starts from, before any run remembers
   * another. Read as `memory.timesCharged`, set by a `remember` step, kept
   * by where it runs, across runs and restarts. None: it remembers nothing.
   */
  memory?: ConfigSchema;
  /** Any one of these starts a run. */
  when: readonly RuleTrigger[];
  /** What one of its triggers starting it while it runs does (`WHILE_RUNNING`). None: it is let go. */
  whileRunning?: WhileRunning;
  /** Must be true for it to act. Unknown is not true: nothing is done, and the run says why. */
  if?: Expr;
  /**
   * What it does, step by step — when what started it has no steps of its
   * own (`stepsOf`): a trigger without, a person's play, another automation.
   */
  then: readonly Step[];
  /**
   * If a step does not succeed — or a person stops it — these, each tried
   * whatever the others do: switching back off what it switched on. No step
   * here waits for a condition to come true: it cannot fail in turn.
   */
  otherwise?: readonly Step[];
};

/** The limits every sequence is held to, whatever a rule asks: checked before it runs, and again as it does. */
export const SEQUENCE_LIMITS = {
  /** The longest pause, watch, or wait for a condition: an hour. */
  waitSeconds: 3_600,
  /** The longest one try of `ensure` is given: ten minutes. */
  trySeconds: 600,
  /** At most this many tries. */
  tries: 10,
  /** Steps within steps, at most this deep: a sequence stays a list a person can follow. */
  depth: 4,
  /** How many automations deep one may start another, counting the first: a chain stays one a person can follow. */
  chain: 4,
  /** The most rounds a `repeat` takes. */
  rounds: 100,
  /** The most steps one run takes, rounds and branches counted: whatever it repeats, a run ends. Its `if a step fails` steps besides. */
  steps: 500,
  /** The most starts that wait for a run to end, for an automation whose triggers queue. */
  queued: 10,
} as const;

/**
 * A rule with its roles and settings left open, shipped by a package: filling
 * it in makes an automation. Namespaced by the type: `acme.weather.forecast-switch`.
 */
export type Recipe = Omit<Rule, 'roles'> & {
  roles: Readonly<Record<string, RecipeRole>>;
  id: string;
  label: string;
  description: string;
  /**
   * How an automation made from it reads, with `{role}` and `{param}` filled
   * in: "At {at}, if {day} looks {condition} by {forecast}, turn {switch} {action}."
   * Without one, a sentence is made from the rule.
   */
  sentence?: string;
};

export const defineRecipe = (recipe: Recipe): Recipe => recipe;

/**
 * Which setting a `write` changes: by its key, for a rule its owner built on
 * their own devices — or by a standard meaning ("chargeLimit"), which
 * a recipe can name without knowing any product.
 */
export type WriteTarget = { key: string; means?: never } | { means: string; key?: never };

/** A `write` step: the part's setting, and its value. */
export type Write = { role: string; value: Expr } & WriteTarget;

/**
 * Whether an automation acts on its own: `off` — it does nothing; `watch`
 * — it decides and says what it would have done; `act` — it does it,
 * through the gateway. The same words in a file, on the API and in the app.
 */
export const AUTOMATION_MODES = ['off', 'watch', 'act'] as const;

export type AutomationMode = (typeof AUTOMATION_MODES)[number];
