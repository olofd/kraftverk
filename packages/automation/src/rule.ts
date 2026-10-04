import type { CapabilityName, CapabilityNeed, ConfigSchema, Value } from '@kraftverk/device-sdk';

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

/** Something that has a value when a rule runs, or is unknown (null). */
export type Expr =
  | { value: Value }
  /** One of the rule's settings. */
  | { param: string }
  /** What the part filling a role reports now, by meaning: `battery.soc`, or a type's own `acme.minutesToFull`. */
  | { read: { role: string; means: string } }
  /** A function a package contributes, over the part filling a role. */
  | { call: string; role: string; args?: Readonly<Record<string, Expr>> }
  | { compare: CompareOp; left: Expr; right: Expr }
  /**
   * A number from two: their sum or difference, or the lower or higher of
   * them — in one unit, as a comparison is: "the charge limit, less 5 %",
   * "the lower of the forecast's hours and 4". Unknown when either is.
   */
  | { math: MathOp; left: Expr; right: Expr }
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
   * with its own level and hold, nothing said twice.
   */
  | { run: RunFact };

/**
 * What a run knows of itself, as values a rule reads: the language's own
 * namespace, `run.…`, beside the parts' readings and the rule's settings —
 * so what it gains later (who started it, which attempt) is a value like
 * these, not a construct of its own.
 *
 * - `trigger`: the id of the trigger that started it. A run played by hand,
 *   or started by another automation, counts as started by the first of its
 *   conditions with an id that holds now — "do what you would do now". The
 *   empty text, `""`, when none with an id did: known, so a rule can tell.
 */
export const RUN_FACTS = ['trigger'] as const;

export type RunFact = (typeof RUN_FACTS)[number];

/** What `math` does with its two numbers. */
export type MathOp = 'add' | 'subtract' | 'min' | 'max';

export const MATH_OPS: readonly MathOp[] = ['add', 'subtract', 'min', 'max'];

/** Two numbers made one; unknown unless both are numbers. */
export const calculate = (op: MathOp, left: Value, right: Value): Value => {
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  return op === 'add' ? left + right : op === 'subtract' ? left - right : op === 'min' ? Math.min(left, right) : Math.max(left, right);
};

export type Trigger =
  /** At this time — "07:00" — on the automation's own clock: every day, or only on `days`. */
  | { at: Expr; days?: readonly Weekday[] }
  /**
   * Every so many minutes, on the owner's clock from midnight: every 15 is
   * :00, :15, :30 and :45. Once a slot; a server that was down runs once, at
   * the latest, and does not catch up. `if` narrows it: "every 15 minutes,
   * between 22:00 and 06:00".
   */
  | { every: Expr }
  /** When the part filling a role raises an event its description declares. */
  | { event: { role: string; event: string } }
  /**
   * When a condition turns true — and, with `heldForMinutes`, has stayed true
   * that long. Reads and comparisons only: it is evaluated on every reading.
   */
  | { becomes: Expr; heldForMinutes?: Expr };

/**
 * A trigger, with an id of its own when what the rule does asks which one
 * started it (`run.trigger`): `low`, `high`. Unique within the rule.
 */
export type NamedTrigger = Trigger & { id?: string };

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
 * sequence still reads as a list a person can follow.
 */
export type Step =
  /** Through the gateway, as any command. */
  | { command: Command }
  /** A pause. */
  | { wait: { seconds: Expr } }
  /** Until a condition is true — or the run stops, not having succeeded, once it has waited that long. */
  | { waitUntil: { condition: Expr; atMostSeconds: Expr } }
  /**
   * Make sure a condition comes true within a time; if it does not, take the
   * `retry` steps and look again, at most `tries` times — then, still not, the
   * run stops, not having succeeded.
   */
  | { ensure: { condition: Expr; withinSeconds: Expr; tries: Expr; retry: readonly Step[] } }
  /** One way or the other, as a condition is now. Unknown is not true: `else`. */
  | { choose: { if: Expr; then: readonly Step[]; else?: readonly Step[] } }
  /**
   * Watch a condition for a while: `then` if it stays true all that time,
   * `else` the moment it is not — or cannot be told. "Watch whether the
   * station's AC output stays below 10 W for 5 s: then switch it off."
   */
  | { watch: { condition: Expr; seconds: Expr; then?: readonly Step[]; else?: readonly Step[] } }
  /**
   * Change a setting the part filling a role offers — "switch the plug's live
   * readings on" — through the gateway, read back as any setting. Never one
   * its device declares dangerous.
   */
  | { write: Write }
  /**
   * Start the automation filling a role, as a person's play would — and, with
   * `waitSeconds`, wait until its run ends: done if it acted, not if it did
   * not, or not within that time.
   */
  | { start: { role: string; waitSeconds?: Expr } };

/** The kinds of step: what a run records each as. */
export type StepKind = 'command' | 'wait' | 'waitUntil' | 'ensure' | 'choose' | 'watch' | 'write' | 'start';

export const stepKind = (step: Step): StepKind =>
  'command' in step
    ? 'command'
    : 'write' in step
      ? 'write'
      : 'start' in step
        ? 'start'
        : 'wait' in step
          ? 'wait'
          : 'waitUntil' in step
            ? 'waitUntil'
            : 'ensure' in step
              ? 'ensure'
              : 'choose' in step
                ? 'choose'
                : 'watch';

/** A role a part of a device fills: what it must offer, and what it is for. */
export type PartRole = CapabilityNeed & { label: string; description: string };

/** A role another automation fills: one a `start` step starts. */
export type AutomationRole = { automation: true; label: string; description: string };

/** What fills a role — a part, or an automation — and what it is for. */
export type RoleSpec = PartRole | AutomationRole;

export const isAutomationRole = (spec: RoleSpec): spec is AutomationRole => 'automation' in spec && spec.automation === true;

/** The roles parts of devices fill: what binding checks, and what a device's page lists. */
export const partRoles = (rule: Pick<Rule, 'roles'>): [string, PartRole][] =>
  Object.entries(rule.roles).filter((entry): entry is [string, PartRole] => !isAutomationRole(entry[1]));

export type Rule = {
  roles: Readonly<Record<string, RoleSpec>>;
  params: ConfigSchema;
  /** Any one of these starts a run. */
  when: readonly NamedTrigger[];
  /** Must be true for it to act. Unknown is not true: nothing is done, and the run says why. */
  if?: Expr;
  /** What it does, step by step. */
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
} as const;

/**
 * A rule with its roles and settings left open, shipped by a package: filling
 * it in makes an automation. Namespaced by the type: `acme.weather.forecast-switch`.
 */
export type Recipe = Rule & {
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
 * their own devices — or by a standard meaning ("battery.chargeLimit"), which
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
