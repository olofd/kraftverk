import type { RuleSteps } from '@kraftverk/automation';
import type { AutomationRun, ConditionState, RunLog } from '@kraftverk/api-contract';
import type { Actor, ClockTimer } from '@kraftverk/device-sdk';
import type { LiveMessage } from '@kraftverk/holder';

import { RuleContext } from './context.ts';
import type { AutomationEngineDeps, AutomationRecord, Asker } from './model.ts';
import { Runs } from './runs.ts';
import { Triggers } from './triggers.ts';

export { RunRefusal, type Asker, type AutomationEngineDeps, type AutomationMode, type AutomationRecord, type EngineDevice, type EngineHistory } from './model.ts';
export { logKeyOf } from './listen.ts';
export { quoted } from './words.ts';

/**
 * Runs the automations (docs/AUTOMATIONS.md, docs/SEQUENCES.md).
 *
 * Every automation is its own rule, with its roles filled in, and runs the
 * same way, whoever wrote the rule — its owner, block by block, or a recipe
 * it was copied from:
 *
 * - `at`: looked at every little while; due once a day at that time, on the
 *   owner's clock and on the days it names.
 * - `event`: heard on the live bus as the device raises it.
 * - `becomes`: evaluated when a reading of a device it reads moves; fires when
 *   the condition turns true, and with `heldForMinutes` once it has stayed
 *   true that long. Its state is kept, so a restart continues from where it
 *   was — a hold resumes with what it had left, and nothing fires twice. An
 *   automation with no state yet — new, just changed, or just let act — takes a
 *   condition already true as the edge.
 * - `asked`: when a person, or an assistant for one, starts it.
 *
 * A condition fires once: what it did then stays until it turns true again,
 * and a person may change it in between. An automation that keeps things so
 * (`recheckMinutes`) looks again on that schedule.
 *
 * A run evaluates the rule's condition — unknown is never true — and then its
 * steps, in order: one that watches says what it would have done; one that acts
 * sends each command through the gateway as `actor: 'automation'`, where
 * dwell, freshness, read-only mode and verification apply and a rule has no
 * way around them. A rule of commands alone is done at once; one that takes
 * steps runs for as long as they last — never longer than their limits — its
 * row written at every step, and said on the live bus, so a screen follows
 * it. If a step does not succeed, or someone stops it, its `otherwise` steps
 * run. A run found unended when the server starts was interrupted: ended as
 * such, never resumed.
 *
 * It runs in the home's master — on a server, so an automation goes on while
 * every app is closed.
 *
 * Made of parts that each own their state: what a rule reads against its
 * parts (`RuleContext`), when an automation starts on its own (`Triggers`),
 * and its runs (`Runs`), each with its log (`listen.ts`).
 */
export class AutomationEngine {
  #timer: ClockTimer | null = null;
  #unsubscribe: (() => void) | null = null;
  readonly #context: RuleContext;
  readonly #runs: Runs;
  readonly #triggers: Triggers;

  constructor(private deps: AutomationEngineDeps) {
    this.#context = new RuleContext(deps);
    this.#runs = new Runs(deps, this.#context);
    this.#triggers = new Triggers(deps, this.#context, this.#runs);
  }

  start(): void {
    this.#runs.endInterrupted();
    // Nobody waits on a tick or on what was heard: what goes wrong is said, never left to bring the server down.
    this.#timer ??= this.#context.clock.setInterval(() => void this.tick().catch((error) => console.error('[automations] a tick failed:', error)), this.deps.everyMs ?? 30_000);
    this.#unsubscribe ??= this.deps.bus?.subscribe((message) => void this.hear(message).catch((error) => console.error('[automations] hearing a device failed:', error))) ?? null;
  }

  stop(): void {
    this.#context.clock.clear(this.#timer);
    this.#timer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#triggers.clear();
  }

  /**
   * Forgets everything it holds of the automations it had: their database was
   * emptied beneath it (`Hub.reset`). Every run ends as if its automation were
   * deleted — neither kept nor on the new timeline — every hold is let go,
   * and what concerns each device is read again from what there is now.
   */
  clear(): void {
    this.#runs.forgetAll('everything was erased');
    this.#triggers.clear();
  }

  /**
   * Forgets what an automation's conditions were: after it changed — its
   * settings, its parts, its mode — what it now watches starts afresh, and a
   * condition already true is its edge. Keeping things so starts afresh too:
   * its first look a whole interval from now.
   */
  reset(automationId: string): void {
    this.#triggers.reset(automationId);
  }

  /**
   * Looks at an automation's conditions at once — just made, changed or
   * let act — rather than at the next reading or the next tick: let act
   * while a condition already holds, it acts now.
   */
  poke(automationId: string): void {
    this.#triggers.poke(automationId);
  }

  /** Lets go of an automation that is gone: a run it takes is stopped; what the store kept went with it. */
  forget(automationId: string): void {
    this.#runs.forget(automationId, 'its automation was deleted');
    this.#triggers.forget(automationId);
  }

  /** Runs whatever is due by the clock. One tick at a time. */
  tick(): Promise<void> {
    return this.#triggers.tick();
  }

  /** What a device said: an event some automation waits for, or a reading some condition reads. */
  hear(message: LiveMessage): Promise<void> {
    return this.#triggers.hear(message);
  }

  /**
   * Starts an automation a person — or an assistant for one — asked for: one
   * started when asked, and not off. One that only watches answers with what
   * it would do, and nothing is sent or kept. One that acts starts, and the
   * run is answered as it stands once it has begun; it goes on taking its
   * steps, said on the live bus as it does.
   */
  startAsked(automationId: string, by: Asker): Promise<AutomationRun> {
    return this.#runs.startAsked(automationId, by);
  }

  /** Stops a run in progress: the step it is in ends as stopped, and its `otherwise` steps run. */
  stopAsked(automationId: string, by: Actor): AutomationRun {
    return this.#runs.stopAsked(automationId, by);
  }

  /** The run an automation is taking now, as it stands; null when none. */
  running(automationId: string): AutomationRun | null {
    return this.#runs.running(automationId);
  }

  /**
   * One run, and what it came to — with why it ran, what it read, how each
   * condition stood and each step it took, so a person can follow it. `check`
   * only decides and says what would happen, and is neither kept nor acted
   * on, whatever the mode. A run that takes steps is said on the live bus at
   * every step, and `onBegun` is given it once it has begun. `askedBy`: who
   * asked for it; none, its own triggers started it.
   */
  run(automation: AutomationRecord, options: Parameters<Runs['run']>[1] = {}): Promise<AutomationRun> {
    return this.#runs.run(automation, options);
  }

  /** One of an automation's runs with its log; null when the run is not one of its. */
  runLog(automation: Pick<AutomationRecord, 'id'>, runId: string): RunLog | null {
    return this.#runs.runLog(automation, runId);
  }

  /** Its steps in words, numbered and nested, as its card shows them. */
  steps(automation: AutomationRecord): RuleSteps {
    return this.#context.steps(automation);
  }

  /**
   * Each condition an automation waits for, as it stands at `at`, and what it
   * read to say so: how a run explains itself, and what its card shows now.
   */
  judge(automation: AutomationRecord, at?: Date): { conditions: ConditionState[]; saw: string[] } {
    return this.#context.judge(automation, at);
  }

  /** When it next looks again to keep things so: null when it does not, or is off. */
  nextLookAt(automation: AutomationRecord): string | null {
    return this.#context.nextLookAt(automation);
  }

  /**
   * Why an automation cannot run as its roles are filled: a removed device, a
   * part that no longer fits, a meaning it does not report, a setting it
   * cannot change — or an automation to start that is gone.
   */
  roleProblems(automation: Pick<AutomationRecord, 'rule' | 'roles' | 'groups' | 'starts'>): string[] {
    return this.#context.roleProblems(automation);
  }
}
