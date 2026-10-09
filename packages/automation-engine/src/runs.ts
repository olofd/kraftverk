import type { AutomationRun, RunLog, RunStep } from '@kraftverk/api-contract';
import type { RunLine } from '@kraftverk/holder';
import {
  bindingsOf,
  eachAsGroup,
  settingOf,
  triggerOf,
  isGroupRole,
  memberRole,
  branchesOf,
  capitalise,
  changedRoles,
  describeSteps,
  evaluate,
  evaluateNow,
  EVERYONE,
  listed,
  measure,
  OWN_HOME,
  paramText,
  parseMessage,
  shown,
  toRemember,
  secondsNow,
  fieldValue,
  negation,
  ruleUses,
  secondsText,
  SEQUENCE_LIMITS,
  settledChoice,
  stepKind,
  stepsOf,
  stepSpec,
  takesSteps,
  type StepOf,
  type Command,
  type Expr,
  type Rule,
  type RoleBinding,
  type RuleScope,
  type Step,
  type StepLine,
  type Write,
} from '@kraftverk/automation';
import { attributeMeaning, MAIN_PART, readingOf, type Actor, type AutomationId, type Value } from '@kraftverk/device-sdk';
import type { GatewayResult, WriteResult } from '@kraftverk/gateway';

import type { RuleContext, StartingEvent } from './context.ts';
import { listen, LOOK_EVERY_SECONDS, READINGS_PER_RUN } from './listen.ts';
import { actorOf, RunRefusal, type Asker, type AutomationEngineDeps, type AutomationRecord } from './model.ts';
import { ACTS, actsOn, lowerFirst, pastOf, quoted } from './words.ts';

/*
  Runs (docs/SEQUENCES.md): started by a trigger, a person, or another
  automation's step; walked step by step through the gateway, as an
  automation — kept and said on the live bus at every step, with their log
  — or, for one that only watches, said as what it would do. One run of an
  automation at a time; a part a run of another chain holds is not changed
  under it.
*/

/**
 * After a run changes something, how long a step that judges readings waits
 * for readings taken since, at most: a station that reports every few seconds
 * still says what its outlets gave before the plug on them was switched off.
 */
const SETTLE_AT_MOST_SECONDS = 15;

/** How long a command refused for a stale reading waits for a fresh one, at most, before it is sent again: a device asked to answer now does so in seconds. */
const FRESH_WAIT_SECONDS = 15;

/** A run taking steps now: its record as it goes, and whether someone has stopped it. */
export type LiveRun = {
  id: string;
  automation: AutomationRecord;
  rule: Rule;
  run: AutomationRun;
  /** Who asked for it — or for the run that started it; null, triggers did. */
  asker: Asker | null;
  /** The automations whose runs started this one, the first first: what a `start` step may not start again. */
  chain: readonly AutomationId[];
  /** The first run of its chain: runs of one chain hold their parts together. */
  root: symbol;
  /** The parts it holds while it runs — every part it may change, as `device:part` — and what it calls each. */
  holds: ReadonlyMap<string, string>;
  /** Who stopped it, once someone has. */
  stoppedBy: string | null;
  /** Its automation was deleted while it ran: it ends at the next step, and is neither kept nor on the timeline. */
  gone: boolean;
  /** What a wait is woken by when it is stopped. */
  wake: Set<() => void>;
  /** How often its rule may switch each role's part, at most: what it tells the gateway. */
  allowance: Record<string, number>;
  /** The key of the trigger that started it (`triggerKey`): its steps, and what `run.trigger` asks. Null when none did. */
  trigger: string | null;
  /** The event a device raised that started it: what `run.event` asks. Null when none did. */
  event: StartingEvent | null;
  /** What it was given, by its inputs' names, in their units: what `given.level` reads. */
  inputs: Readonly<Record<string, Value>>;
  /** When it last changed something — switched a part, changed a setting: what is judged after is read after. 0, not yet. By this server's clock. */
  changedAt: number;
  /** Where its last change falls in what the engine heard and did, in order: what a reading heard after it is after, in the same millisecond too. */
  changedOrder: number;
  /**
   * Where this server heard each reading it uses take its value now, by "device key", in the order the engine
   * hears and does things — not by a clock, whose milliseconds two events can share, and not by the reading's
   * `at`, which a device with a clock of its own may stamp.
   */
  heard: Map<string, number>;
  /** Its log, for a run that takes steps: `look` keeps what its devices say now; `stop` ends it, after one last look. Null for a run that takes none. */
  log: { look: () => void; stop: () => void } | null;
  /** Where its step count starts: what it may take is counted from its first step — and, apart, from the first of its `if a step fails` steps. */
  budgetFrom: number;
};

/** How steps came out: as they should, not, stopped by someone — or ended by a `stop` step, as it went. */
type Walked = 'ok' | 'failed' | 'stopped' | 'ended';

/**
 * Where steps are taken: the automation and its rule as they see them —
 * within a `for each`, the part it is at filling what its steps call it, as
 * a role is — and, by that name, the group it is one of: what its allowance
 * is counted by.
 */
type Here = { automation: AutomationRecord; rule: Rule; each: Readonly<Record<string, string>> };

export class Runs {
  /** Automations running now: one run of the same automation at a time. */
  #running = new Set<string>();
  /** Each running automation's run, as it will end: what a fresh start waits on once it has stopped it. */
  #ending = new Map<string, Promise<unknown>>();
  /** Starts its triggers made while it ran, in order, for an automation whose triggers queue: each taken once the run before it ends. */
  #queued = new Map<string, { why: string; trigger: string | null; event: StartingEvent | null }[]>();
  /** Runs taking steps now, by automation. */
  #live = new Map<string, LiveRun>();
  /** Runs of commands alone, acting now: not shown as running, but stopped all the same when their automation goes. */
  #once = new Map<string, LiveRun>();
  /** What the engine heard and did, counted in the order it happened: a run's readings and changes, told apart in the same millisecond. */
  #order = 0;
  readonly #context: RuleContext;

  constructor(
    private deps: AutomationEngineDeps,
    context: RuleContext
  ) {
    this.#context = context;
  }

  /** Stops the run an automation takes, as one whose automation is gone: neither kept nor on the timeline. */
  forget(automationId: string, why: string): void {
    // What its triggers queued goes with it.
    this.#queued.delete(automationId);
    const live = this.#live.get(automationId) ?? this.#once.get(automationId);
    if (!live) return;
    live.gone = true;
    this.#stopLive(live, why);
  }

  /** Stops every run, as runs whose automations are gone. */
  forgetAll(why: string): void {
    for (const id of [...this.#live.keys(), ...this.#once.keys()]) this.forget(id, why);
  }

  /** Whether a run a trigger started is still taking its steps: another it asks for now would not start. */
  busy(automationId: string): boolean {
    return this.#running.has(automationId);
  }

  /**
   * A run its triggers started, kept. Started while it runs, it does as its
   * rule says (`whileRunning`): let go; the run stopped — as a person would,
   * its fallback taken — and started afresh; or started once the run ends.
   * Null when it did not run now.
   */
  async runAndKeep(automation: AutomationRecord, why: string, trigger: string | null = null, event: StartingEvent | null = null, how: { happening?: boolean } = {}): Promise<AutomationRun | null> {
    // Started again by a trigger sooner than it may be: let go.
    if (trigger !== null && this.#tooSoon(automation, trigger)) return null;
    if (this.#running.has(automation.id)) {
      // A happening — someone arriving — comes once: let go, it is lost for good, so it waits its turn instead.
      const asked = automation.rule.whileRunning ?? 'skip';
      const way = how.happening && asked === 'skip' ? 'queue' : asked;
      if (way === 'skip') return null;
      if (way === 'queue') {
        const waiting = this.#queued.get(automation.id) ?? [];
        // At most so many waiting: one more is let go, as one that skips.
        if (waiting.length < SEQUENCE_LIMITS.queued) this.#queued.set(automation.id, [...waiting, { why, trigger, event }]);
        return null;
      }
      const live = this.#live.get(automation.id) ?? this.#once.get(automation.id);
      if (live) this.#stopLive(live, 'a new start');
      await this.#ending.get(automation.id);
      // Another start got in first: this one is let go.
      if (this.#running.has(automation.id)) return null;
    }
    this.#running.add(automation.id);
    if (trigger !== null) this.deps.store.keepTriggerStarted(automation.id, trigger, this.#context.now().toISOString());
    const going = this.run(automation, { why, trigger, event });
    this.#ending.set(automation.id, going.catch(() => undefined));
    try {
      return await going;
    } catch (error) {
      // Started by a trigger, nobody waits on it: what went wrong is said, never left to bring the server down.
      console.error(`[automations] ${automation.id} could not run:`, error);
      return null;
    } finally {
      this.#ended(automation.id);
    }
  }

  /** Whether a trigger, by its key, started a run of it less than its `at most every` ago. */
  #tooSoon(automation: AutomationRecord, key: string): boolean {
    const every = triggerOf(automation.rule, key)?.atMostEvery;
    const last = every ? this.deps.store.triggerStarted(automation.id, key) : null;
    if (!every || !last) return false;
    const seconds = secondsNow(every, this.#context.scope(automation, automation.rule));
    return seconds !== null && this.#context.now().getTime() - Date.parse(last) < seconds * 1000;
  }

  /** A run of an automation ended: the next of the starts it queued, if any, is taken — as it is now, unless it has been turned off or deleted since. */
  #ended(automationId: string): void {
    this.#running.delete(automationId);
    this.#ending.delete(automationId);
    const waiting = this.#queued.get(automationId) ?? [];
    const [next, ...rest] = waiting;
    if (rest.length) this.#queued.set(automationId, rest);
    else this.#queued.delete(automationId);
    if (!next) return;
    const current = this.deps.store.get(automationId);
    if (!current || current.mode === 'off') return void this.#queued.delete(automationId);
    void this.runAndKeep(current, `${next.why} — once the run before it ended`, next.trigger, next.event);
  }

  /**
   * Starts an automation a person — or an assistant for one — asked for: one
   * started when asked, and not off. One that only watches answers with what
   * it would do, and nothing is sent or kept. One that acts starts, and the
   * run is answered as it stands once it has begun; it goes on taking its
   * steps, said on the live bus as it does.
   */
  async startAsked(automationId: string, by: Asker): Promise<AutomationRun> {
    const automation = this.deps.store.get(automationId);
    if (!automation) throw new RunRefusal('No such automation');
    // Starting is a person's yes to act: one that only watches is its owner's to start, not an assistant's.
    if (by.kind === 'agent' && automation.mode !== 'act') throw new RunRefusal('It only watches: its owner lets it act before an assistant may start it');
    return this.#start(automation, { asker: by, from: null }).begun;
  }

  /**
   * Starts a run — played by a person or an assistant for one, or started by
   * a step of another automation's run (`from`) — for real, whatever its
   * mode: its `if` is looked at, then its steps. Refused when it is off,
   * already running, already in the chain that would start it, or at the
   * end of a chain as long as chains go. `begun`: the run as it stands once
   * it has begun; `ended`: as it came out.
   */
  #start(automation: AutomationRecord, how: { asker: Asker | null; from: LiveRun | null; inputs?: Readonly<Record<string, Value>> }): { begun: Promise<AutomationRun>; ended: Promise<AutomationRun> } {
    if (automation.mode === 'off') throw new RunRefusal('It is off: turn it on to start it');
    if (this.#running.has(automation.id)) throw new RunRefusal('It is already running');
    const chain = how.from ? [...how.from.chain, how.from.automation.id] : [];
    if (chain.includes(automation.id)) throw new RunRefusal('It is already in this chain: started again, it would start itself');
    if (chain.length >= SEQUENCE_LIMITS.chain) throw new RunRefusal(`A chain of automations goes ${SEQUENCE_LIMITS.chain} deep at most`);

    let begun!: (run: AutomationRun) => void;
    let failed!: (error: unknown) => void;
    const started = new Promise<AutomationRun>((resolve, reject) => ((begun = resolve), (failed = reject)));
    this.#running.add(automation.id);
    const why = how.from ? `Started by “${how.from.automation.name}”` : `Started by ${how.asker!.name}`;
    const going = this.run(automation, { why, askedBy: how.asker, from: how.from, chain, onBegun: (run) => begun(run), ...(how.inputs ? { inputs: how.inputs } : {}) });
    this.#ending.set(automation.id, going.catch(() => undefined));
    const ended = going
      .then(
        (run) => (begun(run), run),
        (error: unknown) => {
          // Before it began, the one who asked is told; after, it is said here.
          console.error(`[automations] ${automation.id} could not run:`, error);
          failed(error);
          throw error;
        }
      )
      .finally(() => this.#ended(automation.id));
    // Nobody may wait on its end: what went wrong is already said.
    ended.catch(() => undefined);
    return { begun: started, ended };
  }

  /** Stops a run in progress: the step it is in ends as stopped, and its `otherwise` steps run. */
  stopAsked(automationId: string, by: Actor): AutomationRun {
    const live = this.#live.get(automationId);
    if (!live) throw new RunRefusal('It is not running');
    this.#stopLive(live, by.name);
    return live.run;
  }

  /** The run an automation is taking now, as it stands; null when none. */
  running(automationId: string): AutomationRun | null {
    return this.#live.get(automationId)?.run ?? null;
  }

  #stopLive(live: LiveRun, by: string): void {
    live.stoppedBy ??= by;
    for (const wake of live.wake) wake();
  }

  /** Runs that never ended — the server stopped during them — ended as interrupted, and said so: never resumed. */
  endInterrupted(): void {
    for (const { automationId, run } of this.deps.store.unended()) {
      if (this.#live.has(automationId)) continue;
      const at = this.#context.now().toISOString();
      const inStep = run.steps.find((step) => step.endedAt === null);
      const ended: AutomationRun = {
        ...run,
        outcome: 'interrupted',
        endedAt: at,
        steps: run.steps.map((step) => (step.endedAt === null ? { ...step, outcome: 'stopped', detail: 'The server stopped during it', endedAt: at, until: null } : step)),
        summary: `Interrupted: the server stopped${inStep ? ` during “${inStep.what}”` : ''}. It was not resumed — check what it had switched`,
      };
      this.deps.store.endRun(run.id!, ended);
      const automation = this.deps.store.get(automationId);
      this.deps.record({
        at,
        kind: 'automation.interrupted',
        actor: automation ? actorOf(automation) : { kind: 'automation', id: automationId, name: automationId },
        resourceKind: 'automation',
        resource: automationId,
        summary: `${automation?.name ?? 'An automation'}: ${ended.summary}`,
        detail: { run: run.id },
      });
    }
  }

  /**
   * One run, and what it came to — with why it ran, what it read, how each
   * condition stood and each step it took, so a person can follow it. `check`
   * only decides and says what would happen, and is neither kept nor acted
   * on, whatever the mode. A run that takes steps is said on the live bus at
   * every step, and `onBegun` is given it once it has begun. `askedBy`: who
   * asked for it; none, its own triggers started it.
   */
  async run(
    automation: AutomationRecord,
    options: {
      check?: boolean;
      why?: string;
      askedBy?: Asker | null;
      /** The run whose step started it, in a chain; and the automations already in that chain. */
      from?: LiveRun | null;
      chain?: readonly AutomationId[];
      onBegun?: (run: AutomationRun) => void;
      /**
       * The key of the trigger that started it (`triggerKey`): its steps are
       * the ones it takes. Not given — played, asked, started by another — it
       * is the first of its conditions that holds now; null, none.
       */
      trigger?: string | null;
      /** The event a device raised that started it, what `run.event` asks; none, no event did. */
      event?: StartingEvent | null;
      /** What it is given, by its inputs' names, in their units; not given, their defaults. */
      inputs?: Readonly<Record<string, Value>>;
    } = {}
  ): Promise<AutomationRun> {
    const at = this.#context.now();
    const rule = automation.rule;
    const trigger = options.trigger !== undefined ? options.trigger : this.#context.startedByNow(automation, rule);
    const why = options.why ?? (options.check ? 'Asked what it would do now' : 'As it was set up to');
    const judged = this.#context.judge(automation, at);
    const from = options.from ?? null;
    const run: AutomationRun = {
      id: null,
      at: at.toISOString(),
      endedAt: null,
      startedBy: options.askedBy ?? null,
      startedByRun: from && from.run.id ? { id: from.run.id, automationId: from.automation.id, name: from.automation.name } : null,
      outcome: 'running',
      summary: '',
      why,
      saw: judged.saw,
      conditions: judged.conditions,
      steps: [],
      answered: null,
    };
    /** A run over as it began: kept, and on the timeline, unless it was only asked what it would do. */
    const over = (outcome: AutomationRun['outcome'], summary: string, steps: RunStep[] = [], device?: string): AutomationRun => {
      Object.assign(run, { outcome, summary, steps, endedAt: run.at });
      if (!options.check) {
        run.id = this.deps.store.ran(automation.id, run);
        if (run.id) this.#note(automation, run, device);
      }
      return run;
    };

    const problems = this.#context.roleProblems(automation);
    if (problems.length) return over('unknown', problems.join('; '));

    const event = options.event ?? null;
    const inputs = options.inputs ?? {};
    const scope = this.#context.scope(automation, rule, at, trigger, event, inputs);
    try {
      if (rule.if) {
        const trace: string[] = [];
        const condition = await evaluate(rule.if, scope, trace);
        run.saw = [...new Set([...run.saw, ...trace])];
        // In the words of what it asked — "Tomorrow looks cloudy: 90 % cloud" — or, with none, the condition's own.
        const said = trace.join('; ');
        if (condition === null) return over('unknown', said || `Could not tell whether ${this.#context.said(automation, rule, rule.if)}`);
        if (condition !== true) return over('idle', said || `Not now: ${this.#context.said(automation, rule, negation(rule.if))}`);
      }
    } catch (error) {
      return over('failed', `Could not decide: ${(error as Error).message}`);
    }

    // What it does: what started it says, or the rule. Nothing at all — played between two edges that each say — is not now.
    const steps = stepsOf(rule, trigger);
    if (!steps.length) return over('idle', 'Not now: none of what starts it holds');

    // It acts when it is let act — or when a person played it, or another automation's run started it: the
    // mode says what it does on its own, not what it does when asked. Only asked what it would do, or only
    // watching on its own: what it would do, said once — why it did not act is the run's own why and outcome.
    const acts = !options.check && (automation.mode === 'act' || Boolean(options.askedBy) || from !== null);
    if (!acts) {
      const would = await this.#wouldDo(automation, rule, steps, scope);
      if ('unknown' in would) return over('unknown', `Could not tell what to send ${would.unknown}`);
      const said = would.filter((step) => step.depth === 0).map((step) => `${lowerFirst(step.what)}${step.outcome === 'already' ? ' (already so)' : ''}`);
      return over('would-act', `Would ${said.join(', then ')}`, would, actsOn(automation, rule));
    }

    // Automations take turns with a part: one a run of another chain holds is not changed under it, and this
    // run does nothing rather than wait — what starts it starts it again (docs/SHARED-PARTS-AND-RESERVE.md).
    const holds = new Map(
      // Every part of a group it changes, each by its own name.
      changedRoles(rule).flatMap((role): [string, string][] =>
        bindingsOf(automation, role).map((binding) => [`${binding.device}:${binding.part}`, this.deps.device(binding)?.name ?? scope.name(role)])
      )
    );
    const root = from?.root ?? Symbol(automation.id);
    for (const other of [...this.#live.values(), ...this.#once.values()]) {
      if (other.root === root) continue;
      const shared = [...holds.keys()].find((key) => other.holds.has(key));
      if (shared) return over('refused', `${capitalise(holds.get(shared)!)} is in use by ${quoted(other.automation.name)}, running now`, [], actsOn(automation, rule));
    }

    // Acting: step by step, through the gateway, as an automation — kept and said as it goes when it takes steps.
    const live: LiveRun = {
      id: '',
      automation,
      rule,
      run,
      asker: options.askedBy ?? null,
      chain: options.chain ?? [],
      root,
      holds,
      stoppedBy: null,
      gone: false,
      wake: new Set(),
      // What a "for each" sends each part, its group's parts each may take.
      allowance: this.#allowance(eachAsGroup({ ...rule, then: steps }).then, eachAsGroup(rule).otherwise ?? [], scope),
      trigger,
      event,
      inputs,
      changedAt: 0,
      changedOrder: 0,
      heard: new Map(),
      log: null,
      budgetFrom: 0,
    };
    const stepped = takesSteps(rule);
    if (stepped) {
      run.summary = 'Running';
      live.id = run.id = this.deps.store.beginRun(automation.id, run);
      this.#live.set(automation.id, live);
      live.log = listen(live, { ...this.deps, clock: this.#context.clock }, () => ++this.#order);
      this.#moved(live);
    } else {
      live.id = `once-${automation.id}-${at.getTime()}`;
      this.#once.set(automation.id, live);
    }
    options.onBegun?.(run);

    let walked: Walked;
    const here: Here = { automation, rule, each: {} };
    try {
      walked = await this.#walk(live, here, steps, 0, null, 'then');
      if ((walked === 'failed' || walked === 'stopped') && rule.otherwise?.length) {
        // What it does after counts its steps apart: a run that took all it may still takes these.
        live.budgetFrom = run.steps.length;
        await this.#walk(live, here, rule.otherwise, 0, walked === 'stopped' ? `After it was stopped by ${live.stoppedBy}` : 'After a step did not succeed', 'otherwise');
      }
    } catch (error) {
      walked = 'failed';
      this.#add(live, { kind: 'command', depth: 0, within: null, what: 'The run itself', outcome: 'failed', detail: (error as Error).message, until: null });
    }
    // It switches nothing more: the gateway lets go of what it counted for it.
    this.deps.gateway.runEnded(live.id);
    live.log?.stop();

    const top = run.steps;
    const unverified = top.some((step) => step.outcome === 'unverified');
    // Not succeeding is said by the step that did not, before what it took after: a step is kept as it begins, so the last is the innermost — a part's, not its "for each".
    const after = top.findIndex((step) => step.depth === 0 && step.within?.startsWith('After'));
    const cause = (after < 0 ? top : top.slice(0, after)).findLast((step) => step.outcome === 'timed-out' || step.outcome === 'not-met' || step.outcome === 'failed' || step.outcome === 'refused');
    run.outcome = walked === 'stopped' ? 'stopped' : walked === 'failed' ? (cause?.outcome === 'refused' ? 'refused' : 'failed') : unverified ? 'unverified' : 'acted';
    run.summary = this.#summaryOf(live, walked);
    run.endedAt = this.#context.now().toISOString();
    this.#say(live, { kind: 'ended', depth: 0, what: run.summary, outcome: run.outcome, detail: null });
    const device = actsOn(automation, rule);
    if (stepped) {
      this.#live.delete(automation.id);
      if (!live.gone) {
        this.deps.store.endRun(live.id, run);
        this.#note(automation, run, device);
      }
      this.deps.bus?.publish({ kind: 'automation', automationId: automation.id });
    } else {
      this.#once.delete(automation.id);
      // Deleted while it ran, told or not: its runs went with it, and so does this one.
      run.id = live.gone ? null : this.deps.store.ran(automation.id, run);
      if (run.id) this.#note(automation, run, device);
    }
    if (live.gone) run.id = null;
    return run;
  }

  /** A run on the timeline: what it came to, in a line, and which run it is. */
  #note(automation: AutomationRecord, run: AutomationRun, device?: string): void {
    this.deps.record({
      at: run.endedAt ?? run.at,
      kind: `automation.${run.outcome}`,
      actor: run.startedBy ?? actorOf(automation),
      resourceKind: 'automation',
      resource: automation.id,
      summary: `${automation.name}: ${run.summary}`,
      detail: { run: run.id, why: run.why, ...(device ? { device } : {}) },
    });
  }

  /** A run taking steps moved: kept, and said on the live bus, so its screen follows. */
  #moved(live: LiveRun): void {
    if (this.#live.has(live.automation.id)) this.deps.store.stepRun(live.id, live.run);
    this.deps.bus?.publish({ kind: 'automation', automationId: live.automation.id });
  }

  /** A step, as it begins — or, with an outcome that ends it, as it went. */
  #add(live: LiveRun, step: Omit<RunStep, 'at' | 'endedAt'> & { endedAt?: string | null }, said = false): RunStep {
    const now = this.#context.now().toISOString();
    const done = step.outcome !== 'waiting';
    const entry: RunStep = { ...step, at: now, endedAt: step.endedAt !== undefined ? step.endedAt : done ? now : null };
    live.run.steps.push(entry);
    this.#moved(live);
    this.#say(live, { kind: said ? 'log' : 'step', depth: entry.depth, what: entry.what, outcome: entry.outcome, detail: entry.detail || null });
    return entry;
  }

  #end(live: LiveRun, entry: RunStep, outcome: RunStep['outcome'], detail: string): void {
    Object.assign(entry, { outcome, detail, endedAt: this.#context.now().toISOString(), until: null });
    this.#moved(live);
    this.#say(live, { kind: 'step', depth: entry.depth, what: entry.what, outcome, detail: detail || null });
  }

  /** A line of a run, said on the live bus as it happens: what a console follows. */
  #say(live: LiveRun, line: RunLine): void {
    this.deps.bus?.publish({ kind: 'run', automationId: live.automation.id, name: live.automation.name, runId: live.id, line });
  }

  /**
   * How often each role's part may be switched within one run, at most, as
   * its rule can: every command to it in its steps, a retry's as often as
   * its tries, both ways of a choice. What it tells the gateway, which holds
   * it to its own ceiling besides.
   */
  #allowance(steps: readonly Step[], otherwise: readonly Step[], scope: RuleScope): Record<string, number> {
    const counts: Record<string, number> = {};
    const count = (steps: readonly Step[], times: number): void => {
      for (const step of steps) {
        if ('command' in step) counts[step.command.role] = (counts[step.command.role] ?? 0) + times;
        // Steps within, as often as the step may take them: a retry its count of times, a choice's either way once.
        const spec = stepSpec(step);
        const repeats = spec.fields
          .filter((field) => field.type.type === 'count')
          .reduce((product, field) => {
            const value = evaluateNow(fieldValue(step, field) as Expr, scope);
            return product * (typeof value === 'number' ? Math.max(0, Math.floor(value)) : 0);
          }, 1);
        for (const branch of branchesOf(step)) count(branch.steps, times * repeats);
      }
    };
    count(steps, 1);
    count(otherwise, 1);
    return counts;
  }

  /** Seconds a step's expression says, held to what the language allows. */
  #seconds(expr: Expr, scope: RuleScope, max: number): number | null {
    const value = secondsNow(expr, scope);
    return value !== null && value >= 1 ? Math.min(value, max) : null;
  }

  /**
   * Steps, in order, as it acts. `then` and a choice's or watch's steps in it
   * stop at the first that does not succeed; `otherwise` tries every one
   * whatever the others do, and is not stopped; a retry stops where it
   * cannot go on.
   */
  async #walk(live: LiveRun, here: Here, steps: readonly Step[], depth: number, within: string | null, mode: 'then' | 'retry' | 'otherwise'): Promise<Walked> {
    const scope = () => this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs);
    const stopping = () => live.stoppedBy !== null && mode !== 'otherwise';
    let result: Walked = 'ok';
    for (const step of steps) {
      if (stopping()) return 'stopped';
      const kind = stepKind(step);
      // Whatever it repeats, a run ends: so many steps, and no more.
      if (live.run.steps.length - live.budgetFrom >= SEQUENCE_LIMITS.steps) {
        this.#add(live, { kind, depth, within, what: 'No more steps', outcome: 'failed', detail: `It has taken ${SEQUENCE_LIMITS.steps} steps, as many as one run may`, until: null });
        return 'failed';
      }
      let walked: Walked = 'ok';
      /** The step in words, as its plan shows it. */
      const what = () => describeSteps({ ...here.rule, then: [step], otherwise: [] }, this.#context.settled(here.automation, here.rule), (role) => scope().name(role), this.#context.vocabulary(here.automation)).steps[0]!.text;
      // A choice its owner already made is no step of its own: the steps it chose are taken in its place.
      const chosen = 'choose' in step ? settledChoice(here.rule, step, this.#context.settled(here.automation, here.rule)) : null;

      // Each kind its own way of being taken — every kind, or this does not compile (kinds/steps.ts).
      if (chosen) walked = await this.#walk(live, here, chosen, depth, within, mode);
      else if ('command' in step) walked = await this.#command(live, here, step.command, depth, within, mode === 'otherwise');
      else if ('write' in step) walked = await this.#write(live, here, step.write, depth, within, what());
      else if ('start' in step) walked = await this.#startStep(live, here, step.start, depth, within, what(), mode);
      else if ('script' in step) walked = await this.#script(live, here, step.script, depth, within, what());
      else if ('remember' in step) walked = await this.#remember(live, here, step.remember, depth, within, what());
      else if ('setMode' in step) walked = this.#setMode(live, here, step.setMode, depth, within, what());
      else if ('notify' in step) walked = await this.#notify(live, here, step.notify, depth, within, what());
      else if ('repeat' in step) walked = await this.#repeat(live, here, step.repeat, depth, within, what(), mode);
      else if ('forEach' in step) walked = await this.#forEach(live, here, step.forEach, depth, within, what(), mode);
      else if ('try' in step) walked = await this.#try(live, here, step.try, depth, within, what(), mode);
      else if ('stop' in step) walked = this.#stop(live, here, step.stop, depth, within, what());
      else if ('answer' in step) walked = await this.#answer(live, here, step.answer, depth, within, what());
      else if ('waitFor' in step) walked = await this.#waitFor(live, here, step.waitFor, depth, within, what(), mode === 'otherwise');
      else if ('wait' in step) {
        const seconds = this.#seconds(step.wait.for, scope(), SEQUENCE_LIMITS.waitSeconds) ?? 1;
        const entry = this.#add(live, { kind, depth, within, what: what(), outcome: 'waiting', detail: `For ${secondsText(seconds)}`, until: this.#after(seconds) });
        const woke = await this.#sleep(live, seconds, mode === 'otherwise');
        if (woke === 'stopped') {
          this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
          walked = 'stopped';
        } else this.#end(live, entry, 'done', `Waited ${secondsText(seconds)}`);
      } else if ('waitUntil' in step) {
        const seconds = this.#seconds(step.waitUntil.atMost, scope(), SEQUENCE_LIMITS.waitSeconds) ?? 1;
        const entry = this.#add(live, { kind, depth, within, what: what(), outcome: 'waiting', detail: 'Waiting', until: this.#after(seconds) });
        const came = await this.#until(live, here, step.waitUntil.condition, seconds);
        if (came.outcome === 'met') this.#end(live, entry, 'met', `${came.seconds < 1 ? 'At once' : `After ${secondsText(came.seconds)}`}${came.saw ? ` — ${came.saw}` : ''}`);
        else if (came.outcome === 'stopped') (this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`), (walked = 'stopped'));
        else (this.#end(live, entry, 'timed-out', `Not in ${secondsText(seconds)}${came.saw ? ` — ${came.saw}` : ''}`), (walked = 'failed'));
      } else if ('ensure' in step) {
        const { condition, within: given, tries: triesExpr, retry } = step.ensure;
        const seconds = this.#seconds(given, scope(), SEQUENCE_LIMITS.trySeconds) ?? 1;
        const triesValue = evaluateNow(triesExpr, scope());
        const tries = typeof triesValue === 'number' ? Math.max(0, Math.min(SEQUENCE_LIMITS.tries, Math.floor(triesValue))) : 0;
        const entry = this.#add(live, { kind, depth, within, what: what(), outcome: 'waiting', detail: 'Watching', until: this.#after(seconds) });
        for (let attempt = 0; ; attempt++) {
          Object.assign(entry, { until: this.#after(seconds), detail: attempt === 0 ? 'Watching' : `Watching, after try ${attempt} of ${tries}` });
          this.#moved(live);
          const came = await this.#until(live, here, condition, seconds);
          if (came.outcome === 'met') {
            this.#end(live, entry, 'met', `${attempt === 0 ? 'At once' : `After ${attempt} ${attempt === 1 ? 'try' : 'tries'}`}${came.saw ? ` — ${came.saw}` : ''}`);
            break;
          }
          if (came.outcome === 'stopped') {
            this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
            walked = 'stopped';
            break;
          }
          if (attempt >= tries) {
            this.#end(live, entry, 'timed-out', `Not ${tries ? `in ${tries} ${tries === 1 ? 'try' : 'tries'}` : `in ${secondsText(seconds)}`}${came.saw ? ` — ${came.saw}` : ''}`);
            walked = 'failed';
            break;
          }
          const retried = await this.#walk(live, here, retry, depth + 1, `Try ${attempt + 1} of ${tries}`, 'retry');
          if (retried !== 'ok') {
            this.#end(live, entry, retried === 'stopped' ? 'stopped' : 'failed', retried === 'stopped' ? `Stopped by ${live.stoppedBy}` : `Try ${attempt + 1} could not be made`);
            walked = retried;
            break;
          }
        }
      } else if ('choose' in step) {
        const trace: string[] = [];
        const holds = await evaluate(step.choose.if, scope(), trace).catch(() => null);
        const branch = holds === true ? step.choose.then : (step.choose.else ?? []);
        this.#add(live, { kind, depth, within, what: what(), outcome: 'done', detail: `${holds === true ? 'It is so' : holds === false ? 'It is not so' : 'It cannot be told, so taken as not so'}${trace.length ? ` — ${trace.join('; ')}` : ''}`, until: null });
        walked = await this.#walk(live, here, branch, depth + 1, holds === true ? 'Then' : 'Otherwise', mode);
      } else if ('watch' in step) {
        const seconds = this.#seconds(step.watch.for, scope(), SEQUENCE_LIMITS.waitSeconds) ?? 1;
        const entry = this.#add(live, { kind, depth, within, what: what(), outcome: 'waiting', detail: 'Watching', until: this.#after(seconds) });
        const held = await this.#hold(live, here, step.watch.condition, seconds, mode === 'otherwise');
        if (held.outcome === 'stopped') {
          this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
          walked = 'stopped';
        } else {
          const stayed = held.outcome === 'held';
          this.#end(live, entry, stayed ? 'met' : 'not-met', `${stayed ? `It stayed so for ${secondsText(seconds)}` : `It did not, after ${secondsText(held.seconds)}`}${held.saw ? ` — ${held.saw}` : ''}`);
          walked = await this.#walk(live, here, stayed ? (step.watch.then ?? []) : (step.watch.else ?? []), depth + 1, stayed ? 'It stayed so' : 'It did not', mode);
        }
      } else {
        // A kind the language has and this has no way to take: never silently another.
        const unknown: never = step;
        throw new Error(`No way to take a step of kind ${kind}: ${JSON.stringify(unknown)}`);
      }

      if (walked === 'ok') continue;
      // Ended by a stop: nothing after it is taken, here or above.
      if (walked === 'ended') return 'ended';
      if (mode === 'otherwise') {
        result = walked === 'failed' ? 'failed' : result;
        continue;
      }
      return walked;
    }
    return result;
  }

  /**
   * Steps taken round after round: so many — or until it is so after a
   * round, at most that many, and not succeeding if it never is. A round
   * that does not succeed ends it, as it would the list it is in.
   */
  async #repeat(live: LiveRun, here: Here, repeat: StepOf<'repeat'>['repeat'], depth: number, within: string | null, what: string, mode: 'then' | 'retry' | 'otherwise'): Promise<Walked> {
    const scope = () => this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs);
    const given = evaluateNow(repeat.times, scope());
    const rounds = typeof given === 'number' ? Math.max(0, Math.min(SEQUENCE_LIMITS.rounds, Math.floor(given))) : 0;
    const entry = this.#add(live, { kind: 'repeat', depth, within, what, outcome: 'waiting', detail: rounds ? `Round 1 of ${rounds}` : 'No rounds', until: null });
    for (let round = 1; round <= rounds; round++) {
      Object.assign(entry, { detail: `Round ${round} of ${rounds}` });
      this.#moved(live);
      const walked = await this.#walk(live, here, repeat.steps, depth + 1, `Round ${round}`, mode);
      if (walked === 'stopped') return (this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy} in round ${round}`), 'stopped');
      if (walked === 'ended') return (this.#end(live, entry, 'done', `Ended in round ${round}`), 'ended');
      if (walked === 'failed') return (this.#end(live, entry, 'failed', `Round ${round} did not succeed`), 'failed');
      if (repeat.until) {
        const trace: string[] = [];
        const holds = await evaluate(repeat.until, scope(), trace).catch(() => null);
        const saw = trace.length ? ` — ${[...new Set(trace)].join('; ')}` : '';
        if (holds === true) return (this.#end(live, entry, 'met', `After ${round === 1 ? 'one round' : `${round} rounds`}${saw}`), 'ok');
        if (round === rounds) return (this.#end(live, entry, 'not-met', `Still not so after ${rounds === 1 ? 'one round' : `${rounds} rounds`}${saw}`), 'failed');
      }
    }
    this.#end(live, entry, 'done', rounds === 1 ? 'One round' : `${rounds} rounds`);
    return 'ok';
  }

  /**
   * Steps for each part of a group: one after the other — the rest not taken
   * once one does not succeed, as in any list — or all at the same time,
   * each going on to its end. Within them, what they call each part is it.
   */
  async #forEach(live: LiveRun, here: Here, each: StepOf<'forEach'>['forEach'], depth: number, within: string | null, what: string, mode: 'then' | 'retry' | 'otherwise'): Promise<Walked> {
    const group = here.rule.roles[each.in];
    const members = here.automation.groups[each.in] ?? [];
    const entry = this.#add(live, { kind: 'forEach', depth, within, what, outcome: 'waiting', detail: members.length === 1 ? 'One part' : `${members.length} parts`, until: null });
    if (!group || !isGroupRole(group)) return (this.#end(live, entry, 'failed', `${each.in} is not a group of parts`), 'failed');
    const one = memberRole(group);
    /** Where a part's steps are taken: it fills what they call it. */
    const at = (member: RoleBinding): Here => ({
      automation: { ...here.automation, roles: { ...here.automation.roles, [each.as]: member } },
      rule: { ...here.rule, roles: { ...here.rule.roles, [each.as]: one } },
      each: { ...here.each, [each.as]: each.in },
    });
    const named = (member: RoleBinding) => this.deps.device(member)?.name ?? 'A device you no longer have';
    const came: Walked[] = [];
    if (each.together) came.push(...(await Promise.all(members.map((member) => this.#walk(live, at(member), each.steps, depth + 1, named(member), mode)))));
    else {
      for (const member of members) {
        const walked = await this.#walk(live, at(member), each.steps, depth + 1, named(member), mode);
        came.push(walked);
        // After a failure every step is tried, whatever the others did; otherwise the rest wait on this one.
        if (walked !== 'ok' && !(mode === 'otherwise' && walked === 'failed')) break;
      }
    }
    const stopped = came.includes('stopped');
    const failed = came.filter((walked) => walked === 'failed').length;
    if (stopped) return (this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`), 'stopped');
    if (failed) return (this.#end(live, entry, 'failed', `${failed === 1 ? 'One part' : `${failed} parts`} did not succeed`), 'failed');
    if (came.includes('ended')) return (this.#end(live, entry, 'done', 'Ended within it'), 'ended');
    this.#end(live, entry, 'done', members.length === 1 ? 'One part' : `${members.length} parts`);
    return 'ok';
  }

  /**
   * Steps tried: one that does not succeed is answered by the steps taken
   * after a failure — none, and it goes on as if it had succeeded. A stop,
   * a person's or a step's, is not caught.
   */
  async #try(live: LiveRun, here: Here, tried: StepOf<'try'>['try'], depth: number, within: string | null, what: string, mode: 'then' | 'retry' | 'otherwise'): Promise<Walked> {
    const entry = this.#add(live, { kind: 'try', depth, within, what, outcome: 'waiting', detail: 'Trying', until: null });
    const walked = await this.#walk(live, here, tried.steps, depth + 1, 'Try', mode);
    if (walked === 'ok') return (this.#end(live, entry, 'done', 'It went as it should'), 'ok');
    if (walked === 'stopped') return (this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`), 'stopped');
    if (walked === 'ended') return (this.#end(live, entry, 'done', 'Ended within it'), 'ended');
    if (!tried.recover?.length) return (this.#end(live, entry, 'done', 'A step did not succeed — it goes on'), 'ok');
    Object.assign(entry, { detail: 'A step did not succeed: taking the others' });
    this.#moved(live);
    const recovered = await this.#walk(live, here, tried.recover, depth + 1, 'If it fails', mode);
    if (recovered === 'ok') return (this.#end(live, entry, 'done', 'A step did not succeed, and what it took after did'), 'ok');
    if (recovered === 'stopped') return (this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`), 'stopped');
    if (recovered === 'ended') return (this.#end(live, entry, 'done', 'Ended within it'), 'ended');
    this.#end(live, entry, 'failed', 'A step did not succeed, and neither did what it took after');
    return 'failed';
  }

  /** The run ends here, saying why — as it went, or as not having succeeded. */
  #stop(live: LiveRun, here: Here, stop: StepOf<'stop'>['stop'], depth: number, within: string | null, what: string): Walked {
    this.#add(live, { kind: 'stop', depth, within, what, outcome: stop.failed ? 'failed' : 'done', detail: stop.why, until: null });
    return stop.failed ? 'failed' : 'ended';
  }

  /** The run ends, answering with a value: in its result's unit, one its result takes — else not succeeding, saying why. */
  async #answer(live: LiveRun, here: Here, value: Expr, depth: number, within: string | null, what: string): Promise<Walked> {
    const result = here.rule.result;
    if (!result) return (this.#add(live, { kind: 'answer', depth, within, what, outcome: 'failed', detail: 'It answers nothing: no result is said', until: null }), 'failed');
    const schema = { fields: { result } };
    const measured = await measure(value, this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs)).catch(() => ({ value: null, unit: null }));
    const kept = toRemember(schema, 'result', measured);
    if ('problem' in kept) return (this.#add(live, { kind: 'answer', depth, within, what, outcome: 'failed', detail: `Not answered: ${kept.problem}`, until: null }), 'failed');
    live.run.answered = kept.value;
    this.#add(live, { kind: 'answer', depth, within, what, outcome: 'done', detail: `Answered ${paramText(schema, 'result', kept.value)}`, until: null });
    return 'ended';
  }

  /** Until the part filling a role raises an event — one raised after it began to wait — at most so long. */
  async #waitFor(live: LiveRun, here: Here, wait: StepOf<'waitFor'>['waitFor'], depth: number, within: string | null, what: string, regardless: boolean): Promise<Walked> {
    const seconds = this.#seconds(wait.atMost, this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs), SEQUENCE_LIMITS.waitSeconds) ?? 1;
    const binding = here.automation.roles[wait.role];
    const entry = this.#add(live, { kind: 'waitFor', depth, within, what, outcome: 'waiting', detail: 'Waiting', until: this.#after(seconds) });
    if (!binding) return (this.#end(live, entry, 'failed', 'No device fills its role'), 'failed');
    const since = this.#context.clock.now();
    let unsubscribe: (() => void) | undefined;
    const heard = new Promise<void>((resolve) => {
      unsubscribe = this.deps.bus?.subscribe((message) => {
        if (message.kind === 'event' && message.deviceId === binding.device && (message.event.part ?? MAIN_PART) === binding.part && message.event.id === wait.event) resolve();
      });
    });
    let came = false;
    void heard.then(() => (came = true));
    const slept = await this.#sleep(live, seconds, regardless, heard);
    unsubscribe?.();
    const after = secondsText(Math.max(0, Math.round((this.#context.clock.now() - since) / 1000)));
    if (came) return (this.#end(live, entry, 'met', `After ${after}`), 'ok');
    if (slept === 'stopped') return (this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`), 'stopped');
    this.#end(live, entry, 'timed-out', `Not in ${secondsText(seconds)}`);
    return 'failed';
  }

  /** A value remembered — in its field's unit, one its field takes — for this run's later steps and later runs. */
  async #remember(live: LiveRun, here: Here, remember: { name: string; value: Expr }, depth: number, within: string | null, what: string): Promise<Walked> {
    const schema = here.rule.memory ?? { fields: {} };
    const measured = await measure(remember.value, this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs)).catch(() => ({ value: null, unit: null }));
    const kept = toRemember(schema, remember.name, measured);
    if ('problem' in kept) {
      this.#add(live, { kind: 'remember', depth, within, what, outcome: 'failed', detail: `Not remembered: ${kept.problem}`, until: null });
      return 'failed';
    }
    this.deps.store.remember(here.automation.id, remember.name, kept.value);
    this.#add(live, { kind: 'remember', depth, within, what, outcome: 'done', detail: `Remembered ${paramText(schema, remember.name, kept.value)}`, until: null });
    return 'ok';
  }

  /**
   * One of the steps of the script filling a role (docs/PLAN-SCRIPTS.md §10):
   * given its inputs in their units and what it remembered, run by the hub's
   * runner until it answers, faults, or its run is stopped — what it does
   * said beneath it as it does it — and what it answers remembered.
   */
  async #script(live: LiveRun, here: Here, script: StepOf<'script'>['script'], depth: number, within: string | null, what: string): Promise<Walked> {
    const runner = this.deps.scripts;
    const id = here.automation.scripts[script.role];
    if (!runner || !id) {
      this.#add(live, { kind: 'script', depth, within, what, outcome: 'failed', detail: runner ? 'No script fills it' : 'This place runs no scripts', until: null });
      return 'failed';
    }
    const shape = runner.shape(id);
    const names = Object.keys(shape?.steps ?? {});
    const name = script.step ?? (names.length === 1 ? names[0] : undefined);
    const declared = name !== undefined ? shape?.steps[name] : undefined;
    const scope = this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs);
    // What it is given, each in its input's unit — as it declares them, where it reads.
    const inputs: Record<string, Value> = {};
    for (const [input, expr] of Object.entries(script.args ?? {})) {
      const measured = await measure(expr, scope).catch(() => ({ value: null, unit: null }));
      const kept = declared ? toRemember(declared.inputs, input, measured) : { value: measured.value };
      if ('problem' in kept) {
        this.#add(live, { kind: 'script', depth, within, what, outcome: 'failed', detail: `Not given ${input}: ${kept.problem}`, until: null });
        return 'failed';
      }
      inputs[input] = kept.value;
    }
    // What it remembers is its own, beside the automation's: under the role's name.
    const prefix = `${script.role}.`;
    const kept = Object.fromEntries(Object.entries(this.deps.store.memory(here.automation.id)).flatMap(([key, value]) => (key.startsWith(prefix) ? [[key.slice(prefix.length), value]] : [])));
    // Before it has kept anything, what it remembers is what it declares it starts as.
    const starts = Object.fromEntries(Object.entries(declared?.memory.fields ?? {}).flatMap(([key, field]) => (field.default === undefined ? [] : [[key, field.default as Value]])));
    const memory: Record<string, Value> = { ...starts, ...kept };
    const seconds = SEQUENCE_LIMITS.waitSeconds;
    const entry = this.#add(live, { kind: 'script', depth, within, what, outcome: 'waiting', detail: 'Running', until: this.#after(seconds) });
    const stop = new AbortController();
    const wake = () => stop.abort();
    live.wake.add(wake);
    let done: Awaited<ReturnType<typeof runner.step>>;
    try {
      done = await runner.step({
        automation: here.automation,
        run: { id: live.id, askedBy: live.asker, cause: [...(live.event?.cause ?? []), here.automation.id] },
        scriptId: id,
        step: script.step,
        inputs,
        memory,
        deadline: this.#context.now().getTime() + seconds * 1000,
        signal: stop.signal,
        say: (line) => void this.#add(live, { kind: 'script', depth: depth + 1, within: what, what: line.what, outcome: line.outcome, detail: line.detail ?? '', until: null }, line.said === true),
      });
    } finally {
      live.wake.delete(wake);
    }
    if (stop.signal.aborted && live.stoppedBy !== null) {
      this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
      return 'stopped';
    }
    if ('fault' in done) {
      this.#end(live, entry, 'failed', done.fault);
      return 'failed';
    }
    for (const [key, value] of Object.entries(done.memory)) if (memory[key] !== value) this.deps.store.remember(here.automation.id, `${prefix}${key}`, value);
    if (script.remember !== undefined) {
      const answer = { value: done.answer, unit: declared?.answer?.type === 'number' ? (declared.answer.unit ?? null) : null };
      const kept = toRemember(here.rule.memory ?? { fields: {} }, script.remember, answer);
      if ('problem' in kept) {
        this.#end(live, entry, 'failed', `Its answer was not remembered: ${kept.problem}`);
        return 'failed';
      }
      this.deps.store.remember(here.automation.id, script.remember, kept.value);
    }
    this.#end(live, entry, 'done', done.answer === null ? 'Done' : `Answered ${typeof done.answer === 'string' ? done.answer : JSON.stringify(done.answer)}`);
    return 'ok';
  }

  /** The home a place names — or the automation's own — by its id: what a mode is set on. */
  #homeOf(here: Here, at: string | undefined): string | null {
    const world = this.deps.world;
    if (!world) return null;
    if (!at || at === OWN_HOME) return world.home(here.automation.homeId);
    const fill = here.automation.world[at];
    return fill && 'place' in fill ? world.homeOf({ id: fill.place, kind: fill.kind }) : null;
  }

  /** A home set to a mode, as the automation: already in it, nothing changes. */
  #setMode(live: LiveRun, here: Here, set: { mode: string; at?: string }, depth: number, within: string | null, what: string): Walked {
    const world = this.deps.world;
    const home = this.#homeOf(here, set.at);
    if (!world || !home) {
      this.#add(live, { kind: 'setMode', depth, within, what, outcome: 'failed', detail: world ? 'There is no such home' : 'Modes are not kept here', until: null });
      return 'failed';
    }
    if (world.mode(home, 'presence') === set.mode || world.mode(home, 'day') === set.mode) {
      this.#add(live, { kind: 'setMode', depth, within, what, outcome: 'already', detail: 'It is so now', until: null });
      return 'ok';
    }
    try {
      world.setMode(home, set.mode, actorOf(here.automation), [...(live.event?.cause ?? []), here.automation.id]);
    } catch (error) {
      this.#add(live, { kind: 'setMode', depth, within, what, outcome: 'failed', detail: (error as Error).message, until: null });
      return 'failed';
    }
    this.#add(live, { kind: 'setMode', depth, within, what, outcome: 'done', detail: `${world.placeName({ id: home, kind: 'home' }) ?? 'The home'} is ${set.mode} now`, until: null });
    return 'ok';
  }

  /** People told something: each value in its words said as it is now. */
  async #notify(live: LiveRun, here: Here, notify: StepOf<'notify'>['notify'], depth: number, within: string | null, what: string): Promise<Walked> {
    const world = this.deps.world;
    if (!world) {
      this.#add(live, { kind: 'notify', depth, within, what, outcome: 'failed', detail: 'Nobody can be told from here', until: null });
      return 'failed';
    }
    const fill = here.automation.world[notify.to];
    const people = notify.to === EVERYONE ? world.members() : !fill ? [] : 'person' in fill ? [fill.person] : 'people' in fill ? fill.people : 'everyone' in fill ? world.members() : [];
    if (!people.length) {
      this.#add(live, { kind: 'notify', depth, within, what, outcome: 'failed', detail: 'Nobody to tell', until: null });
      return 'failed';
    }
    const scope = this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs);
    /** Words with each value said as it is now, in its unit — unknown said as such. */
    const said = async (text: string): Promise<string> => {
      const parsed = parseMessage(text);
      if (!parsed.ok) return text;
      const pieces = await Promise.all(
        parsed.pieces.map(async (piece) => {
          if ('text' in piece) return piece.text;
          const measured = await measure(piece.expr, scope).catch(() => ({ value: null, unit: null }));
          return measured.value === null ? 'not known' : typeof measured.value === 'boolean' ? (measured.value ? 'yes' : 'no') : shown(measured.value, measured.unit ?? '');
        })
      );
      return pieces.join('');
    };
    const title = (await said(notify.title)).slice(0, 120);
    const text = notify.text ? (await said(notify.text)).slice(0, 1000) : null;
    let told: readonly string[];
    try {
      told = world.notify(people, { title, text, level: notify.level ?? 'info', homeId: world.home(here.automation.homeId) }, actorOf(here.automation)).told;
    } catch (error) {
      this.#add(live, { kind: 'notify', depth, within, what, outcome: 'failed', detail: (error as Error).message, until: null });
      return 'failed';
    }
    // Told nobody — everyone chosen has left the family — is not done.
    if (!told.length) {
      this.#add(live, { kind: 'notify', depth, within, what, outcome: 'failed', detail: 'Nobody chosen is in the family now', until: null });
      return 'failed';
    }
    const names = notify.to === EVERYONE ? 'everyone' : listed(told.map((id) => world.personName(id) ?? 'someone'));
    this.#add(live, { kind: 'notify', depth, within, what, outcome: 'done', detail: `Told ${names}: “${title}”`, until: null });
    return 'ok';
  }

  /** A command, through the gateway, with the run's allowance: one step. */
  async #command(live: LiveRun, here: Here, command: Command, depth: number, within: string | null, regardless: boolean): Promise<Walked> {
    const scope = this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs);
    const planned = await this.#context.planCommand(here.automation, command, scope);
    if ('unknown' in planned) {
      this.#add(live, { kind: 'command', depth, within, what: `Send ${planned.unknown}`, outcome: 'failed', detail: 'Could not tell what to send', until: null });
      return 'failed';
    }
    const entry = this.#add(live, { kind: 'command', depth, within, what: capitalise(planned.what), outcome: 'waiting', detail: 'Sending', until: null });
    // Why, and what it read to decide: what the device's timeline says the command was for.
    const saw = live.run.saw;
    const reason = `${here.automation.name}: ${live.run.why}${saw.length ? ` (${saw.join('; ')})` : ''}`;
    const send = async (): Promise<GatewayResult> => {
      try {
        return await this.deps.gateway.execute({
          deviceId: planned.binding.device,
          part: planned.binding.part,
          capability: planned.capability,
          command: planned.command,
          args: planned.args,
          reason,
          by: actorOf(here.automation),
          // A part of a group: as often as its group's parts each may be.
          run: { id: live.id, askedBy: live.asker?.kind ?? null, switches: live.allowance[here.each[planned.role] ?? planned.role] ?? 1 },
        });
      } catch (error) {
        return { outcome: 'failed', detail: (error as Error).message };
      }
    };
    let outcome = await send();
    /*
      Switched a moment ago in this run: the gateway's gap is waited out, and
      it is sent once more — a plug to be switched off after a stop that came
      just after it was switched on is still switched off, not left on.
    */
    if (outcome.outcome === 'refused' && outcome.retryInMs !== undefined) {
      const seconds = Math.ceil(outcome.retryInMs / 1000);
      Object.assign(entry, { detail: `Waiting ${secondsText(seconds)}: it was switched a moment ago`, until: this.#after(seconds) });
      this.#moved(live);
      if ((await this.#sleep(live, seconds, regardless)) === 'stopped') {
        this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
        return 'stopped';
      }
      outcome = await send();
    }
    /*
      Refused only because what it acts on was read too long ago — a reading
      late over the network, a device asked too seldom: fresh ones are asked
      for, and it is sent once more as soon as each part has said something
      new. None in time: it stays refused, said as the gateway said it.
    */
    if (outcome.outcome === 'refused' && outcome.stale?.length) {
      Object.assign(entry, { detail: 'Waiting for a fresh reading', until: this.#after(FRESH_WAIT_SECONDS) });
      this.#moved(live);
      const heard = await this.#untilHeard(live, outcome.stale, FRESH_WAIT_SECONDS, regardless);
      if (heard === 'stopped') {
        this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
        return 'stopped';
      }
      if (heard === 'heard') outcome = await send();
    }
    const already = outcome.outcome === 'verified' && outcome.detail.startsWith('Already');
    if (!already && (outcome.outcome === 'verified' || outcome.outcome === 'unverified')) this.#changed(live);
    // What the switch left — the device's own readback — is in the log as it was then.
    live.log?.look();
    this.#end(live, entry, already ? 'already' : outcome.outcome === 'verified' ? 'done' : outcome.outcome, outcome.detail);
    // Unverified is sent, and the step goes on: what follows may be what proves it — a charger that draws.
    return outcome.outcome === 'refused' || outcome.outcome === 'failed' ? 'failed' : 'ok';
  }

  /**
   * A setting changed: through the gateway's write path, read back as any
   * setting is — and not written at all when the part already reads it, so
   * a setting's own dwell is not spent on what is already so.
   */
  async #write(live: LiveRun, here: Here, write: Write, depth: number, within: string | null, what: string): Promise<Walked> {
    const binding = here.automation.roles[write.role];
    const value = binding ? await this.#context.settingValue(binding, write, this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs)) : null;
    const device = binding ? this.deps.device(binding) : null;
    const entry = this.#add(live, { kind: 'write', depth, within, what, outcome: 'waiting', detail: 'Setting', until: null });
    if (!binding || !device || device.removed) {
      this.#end(live, entry, 'failed', `${here.rule.roles[write.role]?.label ?? write.role}: no device`);
      return 'failed';
    }
    if (value === null) {
      this.#end(live, entry, 'failed', 'Could not tell what to set it to');
      return 'failed';
    }
    // By its key, or by what it means: the setting of this part that has the meaning.
    const key = this.#context.settingKey(binding, write);
    if (!key) {
      this.#end(live, entry, 'failed', `${device.name} has no such setting`);
      return 'failed';
    }
    const reading = device.device ? readingOf(device.device.readings(), key) : null;
    if (reading && String(reading.value) === String(value)) {
      this.#end(live, entry, 'already', 'It already was');
      return 'ok';
    }
    let result: WriteResult;
    try {
      result = await this.deps.gateway.write({ deviceId: binding.device, patch: { [key]: value }, by: actorOf(here.automation) });
    } catch (error) {
      result = { outcome: 'failed', detail: (error as Error).message };
    }
    if (result.outcome === 'verified' || result.outcome === 'unverified') this.#changed(live);
    this.#end(live, entry, result.outcome === 'verified' ? 'done' : result.outcome, result.detail);
    return result.outcome === 'refused' || result.outcome === 'failed' ? 'failed' : 'ok';
  }

  /**
   * Another automation started, as a person's play would, asked by whoever
   * asked for this run. With a wait: until its run ends — done if it acted —
   * or the wait runs out; a stop here stops it too.
   */
  async #startStep(
    live: LiveRun,
    here: Here,
    start: Extract<Step, { start: unknown }>['start'],
    depth: number,
    within: string | null,
    what: string,
    mode: 'then' | 'retry' | 'otherwise'
  ): Promise<Walked> {
    const seconds = start.andWait ? (this.#seconds(start.andWait, this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs), SEQUENCE_LIMITS.waitSeconds) ?? 1) : null;
    const entry = this.#add(live, { kind: 'start', depth, within, what, outcome: 'waiting', detail: 'Starting', until: seconds ? this.#after(seconds) : null });
    const target = here.automation.starts[start.role];
    const automation = target ? this.deps.store.get(target) : null;
    if (!automation) {
      this.#end(live, entry, 'failed', 'There is no automation to start: it was deleted');
      return 'failed';
    }
    // What it is given: each worked out here, in the unit of its input there, and one it takes.
    const inputs: Record<string, Value> = {};
    const scope = this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs);
    for (const [name, given] of Object.entries(start.args ?? {})) {
      const kept = toRemember(automation.rule.inputs ?? { fields: {} }, name, await measure(given, scope).catch(() => ({ value: null, unit: null })));
      if ('problem' in kept) return (this.#end(live, entry, 'failed', `Not given ${name}: ${kept.problem}`), 'failed');
      inputs[name] = kept.value;
    }
    let started: { begun: Promise<AutomationRun>; ended: Promise<AutomationRun> };
    try {
      started = this.#start(automation, { asker: live.asker, from: live, inputs });
    } catch (error) {
      if (!(error instanceof RunRefusal)) throw error;
      this.#end(live, entry, 'refused', error.message);
      return 'failed';
    }
    const begun = await started.begun.catch(() => null);
    if (!begun) {
      this.#end(live, entry, 'failed', 'It could not start');
      return 'failed';
    }
    if (seconds === null) {
      this.#end(live, entry, 'done', 'Started');
      return 'ok';
    }
    this.#moved(live);
    const came = await Promise.race([started.ended.then((run) => ({ run })).catch(() => null), this.#sleep(live, seconds, mode === 'otherwise', started.ended).then((slept) => ({ slept }))]);
    if (came && 'run' in came) {
      const acted = came.run.outcome === 'acted';
      // What it answered, remembered here: in the unit it is remembered in.
      if (acted && start.remember !== undefined) {
        const result = automation.rule.result;
        const kept = result ? toRemember(here.rule.memory ?? { fields: {} }, start.remember, settingOf({ fields: { result } }, 'result', came.run.answered ?? undefined)) : { problem: 'it answers nothing' };
        if ('problem' in kept) return (this.#end(live, entry, 'failed', `It ran, and what it answered is not remembered: ${kept.problem}`), 'failed');
        this.deps.store.remember(here.automation.id, start.remember, kept.value);
      }
      this.#end(live, entry, acted ? 'done' : 'failed', `It ${acted ? 'ran' : 'did not succeed'}: ${lowerFirst(came.run.summary)}`);
      return acted ? 'ok' : 'failed';
    }
    // Stopped while it waits: what it waits on stops too. Or the wait ran out: it goes on, and this does not.
    const child = this.#live.get(automation.id);
    if (came && came.slept === 'stopped') {
      // Stopped by the run that started it: "Stopped by “Morning” after it …".
      if (child) this.#stopLive(child, quoted(here.automation.name));
      this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
      return 'stopped';
    }
    this.#end(live, entry, 'timed-out', `It had not ended after ${secondsText(seconds)}`);
    return 'failed';
  }

  /** In a run's words, how it came out. */
  #summaryOf(live: LiveRun, walked: Walked): string {
    // What it did, and — from the first step of its `otherwise` on — what it did after.
    const split = live.run.steps.findIndex((step) => step.depth === 0 && step.within?.startsWith('After'));
    const steps = split < 0 ? live.run.steps : live.run.steps.slice(0, split);
    const later = split < 0 ? [] : live.run.steps.slice(split);
    // What a retry did is no deed of its own: "Try 2 of 3".
    const done = steps.filter((step) => ACTS.has(step.kind) && (step.outcome === 'done' || step.outcome === 'already' || step.outcome === 'unverified') && !/^Try \d+ of/.test(step.within ?? ''));
    // What it changed: what was already so is no deed of its own.
    const changed = done.filter((step) => step.outcome !== 'already').map((step) => lowerFirst(pastOf(step.what)));
    const made = steps.filter((step) => step.kind === 'ensure' && step.outcome === 'met').map((step) => step.detail);
    const afterwards = later.filter((step) => ACTS.has(step.kind) && (step.outcome === 'done' || step.outcome === 'already'));
    const then = afterwards.length ? `; then ${afterwards.map((step) => lowerFirst(pastOf(step.what))).join(', ')}` : '';
    if (walked === 'stopped') return `Stopped by ${live.stoppedBy}${changed.length ? ` after it ${changed.join(', ')}` : ''}${then}`;
    if (walked === 'failed') {
      // Why, in the step that did not: a step is kept as it begins, so the last that did not succeed is the innermost — a round's step, not the round.
      const failing = steps.findLast((step) => step.outcome === 'timed-out' || step.outcome === 'not-met' || step.outcome === 'failed' || step.outcome === 'refused');
      // A stop says why in its own words.
      const said = failing?.kind === 'stop' ? failing.detail : failing ? `${lowerFirst(failing.what)} — ${lowerFirst(failing.detail)}` : 'a step did not';
      return `Did not succeed: ${lowerFirst(said)}${then}`;
    }
    // Ended by a stop: why, in its own words — after what it changed.
    if (walked === 'ended') {
      const why = [...steps].reverse().find((step) => step.kind === 'stop' || step.kind === 'answer')?.detail ?? 'Ended';
      return `${capitalise(why)}${changed.length ? ` — after it ${changed.join(', ')}` : ''}`;
    }
    // What changed leads; what was already so is said once; what it made sure of is said as the reading it saw.
    const sure = made.map((detail) => {
      const [when = '', saw] = detail.split(' — ');
      return saw ? `${saw}, ${lowerFirst(when)}` : lowerFirst(detail);
    });
    const parts = [...(changed.length ? [changed.join(', ')] : done.length ? ['all was already so'] : []), ...sure];
    return parts.length ? capitalise(parts.join('; ')) : 'Nothing needed doing';
  }

  /**
   * What it would do, each step as it would take it: its commands evaluated
   * as they stand now, and one already so said to be — as far as it can be
   * told before the steps before it have run.
   */
  async #wouldDo(automation: AutomationRecord, rule: Rule, list: readonly Step[], scope: RuleScope): Promise<RunStep[] | { unknown: string }> {
    const at = this.#context.now().toISOString();
    const settled = this.#context.settled(automation, rule);
    const steps: RunStep[] = [];
    const flatten = (line: StepLine, depth: number, within: string | null) => {
      steps.push({ kind: line.kind, depth, within, what: line.text, outcome: 'would', detail: '', at, endedAt: at, until: null });
      for (const branch of line.branches) for (const inner of branch.steps) flatten(inner, depth + 1, branch.label);
    };
    const visit = async (list: readonly Step[]): Promise<{ unknown: string } | null> => {
      for (const step of list) {
        // A choice its owner already made: the steps it chose, in its place.
        const chosen = 'choose' in step ? settledChoice(rule, step, settled) : null;
        if (chosen) {
          const unknown = await visit(chosen);
          if (unknown) return unknown;
        } else if ('command' in step) {
          const planned = await this.#context.planCommand(automation, step.command, scope);
          if ('unknown' in planned) return planned;
          const already = this.#context.alreadySo(planned);
          steps.push({ kind: 'command', depth: 0, within: null, what: capitalise(planned.what), outcome: already ? 'already' : 'would', detail: already ? 'It is so now' : '', at, endedAt: at, until: null });
        } else if ('write' in step) {
          // A setting: already so when the part reads what it would be set to.
          const what = describeSteps({ ...rule, then: [step], otherwise: [] }, settled, (role) => scope.name(role), this.#context.vocabulary(automation)).steps[0]!.text;
          const binding = automation.roles[step.write.role];
          const value = binding ? await this.#context.settingValue(binding, step.write, scope) : null;
          const reader = binding ? this.deps.device(binding)?.device : null;
          const key = binding ? this.#context.settingKey(binding, step.write) : null;
          const reading = reader && key ? readingOf(reader.readings(), key) : null;
          const already = value !== null && reading !== null && String(reading.value) === String(value);
          steps.push({ kind: 'write', depth: 0, within: null, what, outcome: already ? 'already' : 'would', detail: already ? 'It is so now' : '', at, endedAt: at, until: null });
        } else {
          for (const line of describeSteps({ ...rule, then: [step], otherwise: [] }, settled, (role) => scope.name(role), this.#context.vocabulary(automation)).steps) flatten(line, 0, null);
        }
      }
      return null;
    };
    return (await visit(list)) ?? steps;
  }

  /** In `seconds` of a step, as an instant. */
  #after(seconds: number): string {
    return new Date(this.#context.now().getTime() + seconds * 1000).toISOString();
  }

  /**
   * A pause that a stop ends early — unless it is to be taken whatever
   * happens. `over`: what it waits beside, which ends it too, once settled:
   * its timer is not left waiting out the rest of the hour for nobody.
   */
  #sleep(live: LiveRun, seconds: number, regardless: boolean, over?: Promise<unknown>): Promise<'slept' | 'stopped'> {
    return new Promise((resolve) => {
      const done = (outcome: 'slept' | 'stopped') => {
        this.#context.clock.clear(timer);
        live.wake.delete(stop);
        resolve(outcome);
      };
      const stop = () => {
        if (!regardless) done('stopped');
      };
      const timer = this.#context.clock.setTimeout(() => done('slept'), seconds * 1000);
      live.wake.add(stop);
      over?.then(
        () => done('slept'),
        () => done('slept')
      );
    });
  }

  /**
   * Asks these parts for fresh readings and waits — at most `seconds` — until
   * each has said something new: what a command refused for a stale reading
   * waits for before it is sent again.
   */
  async #untilHeard(live: LiveRun, parts: readonly RoleBinding[], seconds: number, regardless: boolean): Promise<'heard' | 'late' | 'stopped'> {
    const since = this.#context.clock.now();
    const until = since + seconds * 1000;
    const devices = parts.map((part) => this.deps.device(part));
    for (const device of devices) device?.wantFresh(until);
    const newest = (device: (typeof devices)[number]) => Math.max(0, ...(device?.device?.readings() ?? []).map((reading) => Date.parse(reading.at)));
    const heard = () => devices.every((device) => newest(device) > since);
    while (!heard() && this.#context.clock.now() < until) {
      if ((await this.#sleep(live, 1, regardless)) === 'stopped') return 'stopped';
    }
    return heard() ? 'heard' : 'late';
  }

  /** Keeps what a condition reads fresh while a step waits on it: its holders ask their devices more often, until then. */
  #freshen(live: LiveRun, here: Here, condition: Expr, seconds: number): void {
    const { reads, reaches } = ruleUses({ ...here.rule, when: [], then: [{ waitUntil: { condition, atMost: { value: 1 } } }], otherwise: [] });
    const until = this.#context.clock.now() + seconds * 1000 + 5_000;
    for (const role of new Set([...reads.map((read) => read.role), ...reaches])) {
      const binding = here.automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      device?.wantFresh(until);
    }
  }

  /** One of an automation's runs with its log; null when the run is not one of its. */
  runLog(automation: Pick<AutomationRecord, 'id'>, runId: string): RunLog | null {
    const log = this.deps.store.runLog(automation.id, runId);
    return log ? { ...log, capped: log.readings.length >= READINGS_PER_RUN } : null;
  }

  /** A run changed something — switched a part, changed a setting: what it judges after is judged on what it hears after. */
  #changed(live: LiveRun): void {
    live.changedAt = this.#context.clock.now();
    live.changedOrder = ++this.#order;
  }

  /**
   * Whether every reading a condition reads was taken since the run last
   * changed something — and every device it asks can be reached has been
   * heard from since. A reading from before says how things were, not how
   * they are now: judged on, a supply still giving 190 W a moment after the
   * charger on it was switched off reads as "something else draws".
   */
  #readSince(live: LiveRun, here: Here, condition: Expr): boolean {
    if (!live.changedAt) return true;
    const { reads, reaches } = ruleUses({ ...here.rule, when: [], then: [{ waitUntil: { condition, atMost: { value: 1 } } }], otherwise: [] });
    /*
      Whether it can be reached, likewise: only once something has been heard
      from it since. Its connection's word alone is not enough — a device
      that lost its power with the run's last change (a plug, and the gateway
      it is reached through, on the outlets just switched) keeps a connection
      that looks open for a while, and a command sent into it is lost.
    */
    const heardFrom = (device: string): number | null => {
      const times = [...live.heard].filter(([which]) => which.startsWith(`${device} `)).map(([, at]) => at);
      return times.length ? Math.max(...times) : null;
    };
    const reachedSince = reaches.every((role) => {
      const binding = here.automation.roles[role];
      const heard = binding ? heardFrom(binding.device) : null;
      // One that says nothing at all is judged by its connection, as it is.
      return heard === null || heard > live.changedOrder;
    });
    if (!reachedSince) return false;
    return reads.every(({ role, means }) => {
      const binding = here.automation.roles[role];
      const device = binding ? this.deps.device(binding) : null;
      const attribute = device ? attributeMeaning(device.description, device.part, means) : null;
      const reading = device?.device && attribute ? readingOf(device.device.readings(), attribute.key) : null;
      // Nothing to wait for: what cannot be read is judged as it is.
      if (!reading) return true;
      // Heard after the change, by the order of what happens here; the reading's own time only when the run has not heard it.
      const heard = live.heard.get(`${binding!.device} ${reading.key}`);
      return heard !== undefined ? heard > live.changedOrder : Date.parse(reading.at) >= live.changedAt;
    });
  }

  /** Waits until a condition is true, looking every second: at most `seconds`, or until the run is stopped. */
  async #until(live: LiveRun, here: Here, condition: Expr, seconds: number): Promise<{ outcome: 'met' | 'timed-out' | 'stopped'; seconds: number; saw: string }> {
    this.#freshen(live, here, condition, seconds);
    const started = this.#context.clock.now();
    const unit = 1000;
    for (;;) {
      const saw: string[] = [];
      // Met only on readings taken since the run last changed something.
      const holds = this.#readSince(live, here, condition) ? evaluateNow(condition, this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs), saw) : null;
      const elapsed = (this.#context.clock.now() - started) / unit;
      // What it judged on is in the log, as it was when it judged: the same readings, read at once.
      live.log?.look();
      if (holds === true) return { outcome: 'met', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if (live.stoppedBy !== null) return { outcome: 'stopped', seconds: elapsed, saw: '' };
      if (elapsed >= seconds) return { outcome: 'timed-out', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if ((await this.#sleep(live, Math.min(LOOK_EVERY_SECONDS, seconds - elapsed), false)) === 'stopped') return { outcome: 'stopped', seconds: elapsed, saw: '' };
    }
  }

  /** Watches a condition for `seconds`: held if it is true every time it is looked at; not, the moment it is not — or cannot be told. */
  async #hold(live: LiveRun, here: Here, condition: Expr, seconds: number, regardless: boolean): Promise<{ outcome: 'held' | 'broke' | 'stopped'; seconds: number; saw: string }> {
    this.#freshen(live, here, condition, seconds + SETTLE_AT_MOST_SECONDS);
    const unit = 1000;
    // Watched from the first readings taken since the run last changed something — or, if none come, from when it gave up waiting for them.
    const settling = this.#context.clock.now();
    while (!this.#readSince(live, here, condition) && (this.#context.clock.now() - settling) / unit < SETTLE_AT_MOST_SECONDS) {
      if ((await this.#sleep(live, LOOK_EVERY_SECONDS, regardless)) === 'stopped') return { outcome: 'stopped', seconds: 0, saw: '' };
    }
    const started = this.#context.clock.now();
    for (;;) {
      const saw: string[] = [];
      const holds = evaluateNow(condition, this.#context.scope(here.automation, here.rule, undefined, live.trigger, live.event, live.inputs), saw);
      const elapsed = (this.#context.clock.now() - started) / unit;
      live.log?.look();
      if (holds !== true) return { outcome: 'broke', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if (elapsed >= seconds) return { outcome: 'held', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if ((await this.#sleep(live, Math.min(LOOK_EVERY_SECONDS, seconds - elapsed), regardless)) === 'stopped') return { outcome: 'stopped', seconds: elapsed, saw: '' };
    }
  }
}
