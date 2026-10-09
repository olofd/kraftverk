import type { ConfigField, ConfigSchema } from '@kraftverk/device-sdk';

/*
  Scripts, as the language sees them (docs/PLAN-SCRIPTS.md §8.4, §8.5): what
  a script declares it holds — its steps, with their inputs, answer and
  memory, and its functions, with their arguments and result — in the same
  fields the language's own `inputs:`, `memory:` and `result:` are written
  in; and how far a script may go. The language owns both: it checks the
  automations that use a script against its shape, and says its limits in
  words.
*/

/** One of a script's steps: what it is given, what it answers, what it keeps between runs. */
export type ScriptStepShape = {
  inputs: ConfigSchema;
  answer: ConfigField | null;
  memory: ConfigSchema;
};

/** One of a script's functions: pure, its arguments in order, and what it gives back. */
export type ScriptFunctionShape = {
  args: readonly ConfigField[];
  returns: ConfigField;
};

/** What a script declares, by its exports' names: read from it, never written beside it. */
export type ScriptShape = {
  steps: Record<string, ScriptStepShape>;
  functions: Record<string, ScriptFunctionShape>;
};

/** What is wrong with a script, and where, when it is known: its line and column, counted from 1. */
export type ScriptProblem = { message: string; line: number | null; column: number | null };

/** A script read: what it declares, or what is wrong with it. */
export type ScriptCheck = { shape: ScriptShape | null; problems: ScriptProblem[] };

/** How far a script may go: each said in words where it is reached. */
export const SCRIPT_LIMITS = {
  /** The longest a script's source may be, in bytes. */
  sourceBytes: 65_536,
  /** The longest reading what a script declares may take. */
  describeMs: 50,
  /** A step's heap and stack. */
  stepMemoryBytes: 32 * 1024 * 1024,
  stepStackBytes: 512 * 1024,
  /** The longest a step runs without waiting on the hub. */
  sliceMs: 100,
  /** The most work one step's run may do, all its slices counted. */
  stepCpuMs: 2_000,
  /** The most calls to the home in one step's run. */
  calls: 500,
  /** Of those, the most that change something. */
  acts: 50,
  /** The most lines of its log a run keeps; the rest are counted. */
  logLines: 100,
  /** The largest answer a step gives, as JSON. */
  answerBytes: 16_384,
  /** A function's heap, and the longest one call may take. */
  functionMemoryBytes: 8 * 1024 * 1024,
  functionMs: 5,
  /** The most sandboxes one hub keeps open at once. */
  sandboxes: 8,
} as const;
