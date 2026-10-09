import type { ScriptProblem, ScriptShape } from '@kraftverk/automation';

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

/** A script to keep: its key made from its name when not given. */
export type ScriptInput = { key?: string; name: string; source: string };
