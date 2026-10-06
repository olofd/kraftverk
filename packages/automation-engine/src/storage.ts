import type { RunLog } from '@kraftverk/api-contract';
import type { Value } from '@kraftverk/device-sdk';

import type { AutomationRun } from '@kraftverk/api-contract';

import type { AutomationRecord } from './model.ts';

/** A `becomes` trigger's state, as kept: whether its condition held, since when, and whether this hold has run it. */
export type TriggerState = { last: boolean; heldSince: string | null; fired: boolean };

/**
 * Where the engine's automations are kept, with what their triggers last saw
 * and every run: what it asks of the place it runs. The engine names no
 * database; `@kraftverk/store` keeps these in SQLite, on the server and in
 * the app alike (docs/PLAN-SHARED-CORE.md, principle 3).
 */
export interface AutomationStorage {
  /** Moves whenever an automation is made, changed or deleted: what the engine's index of them is kept by. */
  readonly revision: number;
  list(): AutomationRecord[];
  get(id: string): AutomationRecord | null;

  /** What a trigger last saw, by its key (`triggerKey`): its id, or its place in the rule when it has none. */
  trigger(id: string, trigger: string): TriggerState | null;
  keepTrigger(id: string, trigger: string, state: TriggerState): void;
  /** It starts afresh: what its triggers saw, and when each last started it, is forgotten, and it last looked now. */
  startAfresh(id: string, at: string): void;
  /** When a trigger, by its key, last started a run of it: what `at most every` is counted from. Null: not since it started afresh. */
  triggerStarted(id: string, trigger: string): string | null;
  /** A trigger started a run of it, now. */
  keepTriggerStarted(id: string, trigger: string, at: string): void;
  /** It looked again, to keep things so. */
  looked(id: string, at: string): void;

  /** What it remembers, by name: each value as a run last left it — kept across runs, restarts and changes to it. */
  memory(id: string): Record<string, Value>;
  /** A run remembered a value: kept until one remembers another. */
  remember(id: string, name: string, value: Value): void;

  /** A run that takes steps, begun: its id, written again at every step. */
  beginRun(automationId: string, run: AutomationRun): string;
  /** Where a run has got to. */
  stepRun(runId: string, run: AutomationRun): void;
  /** A run ended, as it came out. */
  endRun(runId: string, run: AutomationRun): void;
  /** A run over as it began, kept at once; null when its automation was deleted while it ran. */
  ran(automationId: string, run: AutomationRun): string | null;
  /** Runs that never ended: interrupted, when found as the engine starts. */
  unended(): { automationId: string; run: AutomationRun }[];

  /** What devices said while a run ran, added to what is kept of it. */
  recordLog(runId: string, log: Partial<Pick<RunLog, 'devices' | 'roles' | 'keys' | 'readings' | 'reach'>>): void;
  /** A run's log, as kept. */
  runLog(automationId: string, runId: string): Omit<RunLog, 'capped'> | null;
}
