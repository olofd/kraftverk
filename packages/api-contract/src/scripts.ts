import type { ScriptProblem, ScriptShape } from '@kraftverk/automation';
import type { Value } from '@kraftverk/device-sdk';

/*
  Scripts in TypeScript, as a home answers them (docs/PLAN-SCRIPTS.md): the
  family's, each by its key — its source as written, and what the home's
  engine reads from it now.
*/

/** One of the family's scripts. */
export type ScriptView = {
  id: string;
  /** Its name in configuration. */
  key: string;
  name: string;
  /** The TypeScript as written. */
  source: string;
  /** What it declares, read by this home's engine; null when it cannot be read — its problems say why. */
  shape: ScriptShape | null;
  problems: ScriptProblem[];
  updatedAt: string;
  /** Who last changed it, as they were called then. */
  updatedBy: string;
};

/** One of a script's steps to try now, as written: which, and what it is given, each in its input's unit. */
export type ScriptTry = {
  source: string;
  step: string;
  inputs: Record<string, Value>;
  /** The person's yes to commands a try before asked one for, by what each is: the gateway's tokens, as `asked` gave them. */
  yes?: Record<string, string>;
};

/** A step tried: what it did, line by line as a run's log says it; its answer; what it would remember — or why it failed. Nothing is kept. */
export type ScriptTried = {
  lines: { what: string; outcome: 'done' | 'refused' | 'failed' | 'unverified'; detail: string | null }[];
  answer: Value | null;
  memory: Record<string, Value>;
  fault: string | null;
  /** Commands the gateway would do only with the person's yes: what each is, its token, and why it asks — tried again with them as `yes`. */
  asked: { key: string; token: string; what: string }[];
};

/** A script to keep: its key made from its name when not given. */
export type ScriptInput = { key?: string; name: string; source: string };
