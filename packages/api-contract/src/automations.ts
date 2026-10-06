import type { AutomationDraft, AutomationMode, ProblemArea, RoleFills, Rule, StepKind, StepLine } from '@kraftverk/automation';
import type { AutomationId, CapabilityName, EnumOption, Quantity, Value, ValueType } from '@kraftverk/device-sdk';

/*
  Automations as a home answers for them: what can be made from (recipes,
  functions), an automation with its last run, its runs step by step, and
  each run's log of what its parts read.
*/

/**
 * A recipe the master offers, as a starting point (docs/AUTOMATION-EDITOR.md):
 * a rule with roles to fill and settings, which the app copies — its
 * settings written into its blocks (`inlineParams`) — into an automation its
 * owner then edits. Recipes come with the installed packages; `from` says
 * which.
 */
export type RecipeView = {
  /** Namespaced by the type it came with: `acme.weather.forecast-switch`. */
  id: string;
  label: string;
  description: string;
  /** The package it came with; null for the shared vocabulary's own. */
  from: { typeId: string; name: string } | null;
  /** It waits for a condition to come true: only then can an automation of it keep things so (`recheckMinutes`). */
  hasConditions: boolean;
  /** It takes steps — waits, makes sure, chooses — rather than sending its commands at once. */
  takesSteps: boolean;
  /** Its steps in words, its roles named by their labels and its settings at their defaults. */
  steps: StepLine[];
  /** Each trigger's own steps in words, by its place under `when`: empty, it takes `steps`. */
  whenSteps: StepLine[][];
  /** The rule itself, with its roles and its settings. */
  rule: Rule;
};

/**
 * A function an installed package offers a condition — "does tomorrow look
 * sunny?" — asked of a part that offers what it `needs`, with its arguments,
 * answering a value of `returns`. What an owner's condition may call.
 */
export type FunctionView = {
  /** Namespaced by the type it came with: `acme.weather.skyLooks`. */
  id: string;
  label: string;
  description: string;
  needs: { capabilities: readonly CapabilityName[]; oneOf?: readonly CapabilityName[] };
  args: Record<string, ValueType>;
  returns: ValueType;
};

/** `GET /automations/recipes`: what an automation can start from, and the functions its conditions may ask. */
export type AutomationKit = { recipes: RecipeView[]; functions: FunctionView[] };

/** `POST /automations/draft`: what is wrong with a draft — empty, nothing — and how it reads. Nothing is kept. */
export type AutomationDraftView = {
  problems: string[];
  /** The same problems, by the part of the automation each is in: what the editor shows beside it. */
  areas: Record<ProblemArea, string[]>;
  sentence: string;
  when: string[];
  steps: StepLine[];
  /** Each trigger's own steps in words, by its place under `when`: empty, it takes `steps`. */
  whenSteps: StepLine[][];
  otherwise: StepLine[];
  takesSteps: boolean;
  /** Each role's name as its steps say it: "Scooter plug", "“Charge the scooter”". */
  names: Record<string, string>;
};

/**
 * `POST /automations`. `key`: its name in configuration; made from its name
 * when not given. `timeZone` is the app's own clock: "Europe/Stockholm".
 * `madeFrom`: the recipe it was copied from.
 */
export type NewAutomation = AutomationDraft & { name: string; key?: string; madeFrom?: string | null; timeZone: string; recheckMinutes?: number | null };

/**
 * `PATCH /automations/:id`. A new rule comes with what fills its roles. Letting
 * it act, or changing one that acts, needs `confirmation`. `homePlace`: its
 * place among the shortcuts on the home page; null, off it.
 */
export type AutomationChanges = Partial<AutomationDraft> & {
  name?: string;
  /** Its name in configuration: lowercase letters, digits and dashes, no other automation's. */
  key?: string;
  timeZone?: string;
  mode?: AutomationMode;
  recheckMinutes?: number | null;
  homePlace?: number | null;
  confirmation?: string;
};

export type AutomationRun = {
  /**
   * Which run it is; null when it is not kept: what it would do, asked, or a
   * run whose automation was deleted while it ran. Its outcome says which.
   */
  id: string | null;
  /** When it started. */
  at: string;
  /** The person or assistant who started it — or the run that started it; null when its own triggers did. */
  startedBy: string | null;
  /** The run of another automation whose step started it; null when none did, or it is gone. */
  startedByRun: { id: string; automationId: AutomationId; name: string } | null;
  /** When it ended; null while it runs. A run of commands alone ends as it starts. */
  endedAt: string | null;
  outcome:
    | 'acted' // what it did, the gateway carried out, verified
    | 'unverified' // the gateway sent it, but the effect is not proven
    | 'would-act' // watching: it would have acted
    | 'idle' // the condition was not met
    | 'unknown' // it could not tell
    | 'refused' // the gateway said no
    | 'failed' // a command errored, or a step did not succeed: waited in vain, never made sure
    | 'running' // it is taking its steps now
    | 'stopped' // someone stopped it
    | 'interrupted'; // the master restarted while it ran: it was ended, not resumed
  /** The run in one line, for a timeline or an assistant: "Turned Heater plug off". */
  summary: string;
  /**
   * What started it, in words: "Garage station's charge is at least 50 %",
   * "Every day at 07:00", "Looked again after 10 min: … still holds", "Asked
   * what it would do now", "Started by olof".
   */
  why: string;
  /** What it read to decide, as it was then: "Garage station: Charge 74.2 %". */
  saw: string[];
  /** Each condition it waits for, as it stood then. */
  conditions: ConditionState[];
  /**
   * Each step it took, or would have, in order, as it went — nested steps
   * after the step they belong to, one level deeper. Empty when it did
   * nothing.
   */
  steps: RunStep[];
  /** What it answered — an `answer` step's value, in its result's unit — or null: it answered nothing. */
  answered: Value | null;
};

/** One condition an automation waits for, and whether it holds: null when it cannot be judged (a device gone quiet). */
export type ConditionState = { text: string; holds: boolean | null };

/** A step of a run, as it went (docs/SEQUENCES.md). */
export type RunStep = {
  kind: StepKind;
  /** How deep it is: 0 for the rule's own steps, 1 for a step within one — a retry's, a choice's. */
  depth: number;
  /** What it is within, for a step with depth: "Try 2 of 3", "If it stays so", "After a step did not succeed". */
  within: string | null;
  /** "Turn Heater plug off", "Wait until Charger plug can be reached — at most 2 min". */
  what: string;
  /**
   * A command — done: carried out, and the device agrees; already: it
   * already was; unverified: sent, not proven; refused: the gateway said no;
   * failed: it errored; would: only watching, so nothing was sent.
   * A wait, a watch, making sure — waiting: now; met: it came true (a watch:
   * it stayed so); not-met: a watch that saw it not so; timed-out: it never
   * came true in time (making sure: in all its tries); done: a pause over, a
   * choice made. stopped: someone stopped the run here.
   */
  outcome: 'done' | 'already' | 'unverified' | 'refused' | 'failed' | 'would' | 'waiting' | 'met' | 'not-met' | 'timed-out' | 'stopped';
  /** In the gateway's words, or the engine's: "Confirmed by the device", "After 23 s", "Charger plug draws 238 W". */
  detail: string;
  at: string;
  endedAt: string | null;
  /** While it waits: until when, at the latest. */
  until: string | null;
};

export type AutomationView = RoleFills & {
  id: AutomationId;
  /** Its name in configuration: what a file and an import know it by (docs/CONFIG.md). */
  key: string;
  name: string;
  /** Its own rule, as its owner built it (docs/AUTOMATION-EDITOR.md). */
  rule: Rule;
  /** The recipe it was copied from, to say so; null when built from nothing. */
  madeFrom: { id: string; label: string } | null;
  /** What it does, in a sentence: "At 07:00, if tomorrow looks sunny by Weather, turn Heater plug on." */
  sentence: string;
  /** When it runs on its own, a sentence a trigger: "When Station's charge is below 15 % for 2 min". Empty: only when played or started. */
  when: string[];
  /** Each role's name as its steps say it: "Scooter plug", "“Charge the scooter”". */
  names: Record<string, string>;
  timeZone: string;
  /** Its place among the shortcuts on the home page; null when it is not there. */
  homePlace: number | null;
  mode: AutomationMode;
  /**
   * Keeping things so: every this many minutes, a condition that still holds
   * runs it again, unless what it would do is already so — or another
   * automation set it since: the last edge wins. Null: what it did stays
   * until a condition turns true again, and a person may change it.
   */
  recheckMinutes: number | null;
  /**
   * The other automations that change parts it changes, and which: "Also
   * changed by “Stop charging”: Scooter plug". While one runs, the other's run
   * that needs a part it holds is refused (docs/SHARED-PARTS-AND-RESERVE.md).
   */
  sharedWith: { id: AutomationId; name: string; parts: string[] }[];
  createdAt: string;
  updatedAt: string;
  /** Its latest run that has ended; null before its first. */
  lastRun: AutomationRun | null;
  /** Each condition it waits for, as it stands now, and what it reads to say so. */
  now: { conditions: ConditionState[]; saw: string[] };
  /** When it next looks again to keep things so; null when it does not, or is off. */
  nextLookAt: string | null;
  /** Why it cannot run as it is: a removed device. Empty when it can. */
  problems: string[];
  /** What it does, step by step, in words — each trigger's own, by its place under `when` (empty: it takes `steps`) — and what it does if a step does not succeed. */
  steps: StepLine[];
  whenSteps: StepLine[][];
  otherwise: StepLine[];
  /** It takes steps rather than sending its commands at once. */
  takesSteps: boolean;
  /** The run it is taking now, step by step as it goes; null when none runs. */
  running: AutomationRun | null;
};

/** `GET /automations/:id/runs`: its runs, the latest first — each with every step it took. */
export type AutomationRuns = { runs: AutomationRun[] };

/** A device a run used, as it was when the run ran. */
export type RunLogDevice = { id: string; name: string; typeId: string };

/** Which part of which device filled one of the run's roles as it ran. */
export type RunLogRole = { role: string; label: string; device: string; part: string };

/**
 * A value a run's log kept, as its device described it then: a number with
 * its unit and quantity, on/off with the words for each, one of some options,
 * or text (anything else, as JSON).
 */
export type RunLogKey = {
  device: string;
  key: string;
  part: string;
  label: string;
  kind: 'number' | 'boolean' | 'enum' | 'text';
  unit: string | null;
  quantity: Quantity | null;
  /** For on/off: how each is said; null when plainly on and off. */
  words: { true: string; false: string } | null;
  /** For one of some options: each option's label; null for any other kind. */
  options: EnumOption[] | null;
};

/** A reading a run's device gave: when the device took it, and when the run heard it. */
export type RunLogReading = { device: string; key: string; at: string; heardAt: string; value: Value };

/** Whether a run's device could be reached, from when — and why not, in its holder's words. */
export type RunLogReach = { device: string; at: string; reachable: boolean; detail: string };

/**
 * A run's log (`GET /automations/:id/runs/:runId/log`, docs/SEQUENCES.md):
 * the run, the devices and roles it used and every value they gave while it
 * ran, the earliest first — whole whatever became of the devices since.
 */
export type RunLog = {
  run: AutomationRun;
  devices: RunLogDevice[];
  roles: RunLogRole[];
  keys: RunLogKey[];
  readings: RunLogReading[];
  reach: RunLogReach[];
  /** It gave more readings than a run keeps: those after the last kept are not here. */
  capped: boolean;
};
