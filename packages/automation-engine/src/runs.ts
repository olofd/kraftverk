import type { AutomationRun, RunLog, RunStep } from '@kraftverk/api-contract';
import { branchesOf, capitalise, changedRoles, describeSteps, evaluate, evaluateNow, fieldValue, negation, ruleUses, secondsText, SEQUENCE_LIMITS, settledChoice, stepKind, stepSpec, takesSteps, type Command, type Expr, type Rule, type RuleScope, type Step, type StepLine, type Write } from '@kraftverk/automation';
import { attributeMeaning, readingOf, type AutomationId } from '@kraftverk/device-sdk';
import type { GatewayResult, WriteResult } from '@kraftverk/gateway';

import type { RuleContext } from './context.ts';
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
  /** The id of the trigger that started it, what `startedBy` asks; null when none with an id did. */
  trigger: string | null;
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
};

type Walked = 'ok' | 'failed' | 'stopped';

export class Runs {
  /** Automations running now: one run of the same automation at a time. */
  #running = new Set<string>();
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

  async runAndKeep(automation: AutomationRecord, why: string, trigger: string | null = null): Promise<AutomationRun | null> {
    if (this.#running.has(automation.id)) return null;
    this.#running.add(automation.id);
    try {
      return await this.run(automation, { why, trigger });
    } catch (error) {
      // Started by a trigger, nobody waits on it: what went wrong is said, never left to bring the server down.
      console.error(`[automations] ${automation.id} could not run:`, error);
      return null;
    } finally {
      this.#running.delete(automation.id);
    }
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
    if (by.actor === 'agent' && automation.mode !== 'act') throw new RunRefusal('It only watches: its owner lets it act before an assistant may start it');
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
  #start(automation: AutomationRecord, how: { asker: Asker | null; from: LiveRun | null }): { begun: Promise<AutomationRun>; ended: Promise<AutomationRun> } {
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
    const ended = this.run(automation, { why, askedBy: how.asker, from: how.from, chain, onBegun: (run) => begun(run) })
      .then(
        (run) => (begun(run), run),
        (error: unknown) => {
          // Before it began, the one who asked is told; after, it is said here.
          console.error(`[automations] ${automation.id} could not run:`, error);
          failed(error);
          throw error;
        }
      )
      .finally(() => this.#running.delete(automation.id));
    // Nobody may wait on its end: what went wrong is already said.
    ended.catch(() => undefined);
    return { begun: started, ended };
  }

  /** Stops a run in progress: the step it is in ends as stopped, and its `otherwise` steps run. */
  stopAsked(automationId: string, by: string): AutomationRun {
    const live = this.#live.get(automationId);
    if (!live) throw new RunRefusal('It is not running');
    this.#stopLive(live, by);
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
        actor: `automation:${automation?.name ?? automationId}`,
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
       * The id of the trigger that started it, what `startedBy` asks: null,
       * one without an id did. Not given — played, asked, started by
       * another — it is the first of its conditions that holds now.
       */
      trigger?: string | null;
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
      startedBy: options.askedBy?.name ?? null,
      startedByRun: from && from.run.id ? { id: from.run.id, automationId: from.automation.id, name: from.automation.name } : null,
      outcome: 'running',
      summary: '',
      why,
      saw: judged.saw,
      conditions: judged.conditions,
      steps: [],
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

    const scope = this.#context.scope(automation, rule, at, trigger);
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

    // It acts when it is let act — or when a person played it, or another automation's run started it: the
    // mode says what it does on its own, not what it does when asked. Only asked what it would do, or only
    // watching on its own: what it would do, said once — why it did not act is the run's own why and outcome.
    const acts = !options.check && (automation.mode === 'act' || Boolean(options.askedBy) || from !== null);
    if (!acts) {
      const steps = await this.#wouldDo(automation, rule, scope);
      if ('unknown' in steps) return over('unknown', `Could not tell what to send ${steps.unknown}`);
      const said = steps.filter((step) => step.depth === 0).map((step) => `${lowerFirst(step.what)}${step.outcome === 'already' ? ' (already so)' : ''}`);
      return over('would-act', `Would ${said.join(', then ')}`, steps, actsOn(automation, rule));
    }

    // Automations take turns with a part: one a run of another chain holds is not changed under it, and this
    // run does nothing rather than wait — what starts it starts it again (docs/SHARED-PARTS-AND-RESERVE.md).
    const holds = new Map(
      changedRoles(rule).flatMap((role): [string, string][] => {
        const binding = automation.roles[role];
        return binding ? [[`${binding.device}:${binding.part}`, scope.name(role)]] : [];
      })
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
      allowance: this.#allowance(rule, scope),
      trigger,
      changedAt: 0,
      changedOrder: 0,
      heard: new Map(),
      log: null,
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
    try {
      walked = await this.#walk(live, rule.then, 0, null, 'then');
      if (walked !== 'ok' && rule.otherwise?.length) {
        await this.#walk(live, rule.otherwise, 0, walked === 'stopped' ? `After it was stopped by ${live.stoppedBy}` : 'After a step did not succeed', 'otherwise');
      }
    } catch (error) {
      walked = 'failed';
      this.#add(live, { kind: 'command', depth: 0, within: null, what: 'The run itself', outcome: 'failed', detail: (error as Error).message, until: null });
    }
    // It switches nothing more: the gateway lets go of what it counted for it.
    this.deps.gateway.runEnded(live.id);
    live.log?.stop();

    const top = run.steps;
    const refused = top.some((step) => step.outcome === 'refused');
    const unverified = top.some((step) => step.outcome === 'unverified');
    run.outcome = walked === 'stopped' ? 'stopped' : walked === 'failed' ? (refused && !top.some((step) => step.outcome === 'timed-out' || step.outcome === 'failed') ? 'refused' : 'failed') : unverified ? 'unverified' : 'acted';
    run.summary = this.#summaryOf(live, walked);
    run.endedAt = this.#context.now().toISOString();
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
      actor: run.startedBy ?? `automation:${automation.name}`,
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
  #add(live: LiveRun, step: Omit<RunStep, 'at' | 'endedAt'> & { endedAt?: string | null }): RunStep {
    const now = this.#context.now().toISOString();
    const done = step.outcome !== 'waiting';
    const entry: RunStep = { ...step, at: now, endedAt: step.endedAt !== undefined ? step.endedAt : done ? now : null };
    live.run.steps.push(entry);
    this.#moved(live);
    return entry;
  }

  #end(live: LiveRun, entry: RunStep, outcome: RunStep['outcome'], detail: string): void {
    Object.assign(entry, { outcome, detail, endedAt: this.#context.now().toISOString(), until: null });
    this.#moved(live);
  }

  /**
   * How often each role's part may be switched within one run, at most, as
   * its rule can: every command to it in its steps, a retry's as often as
   * its tries, both ways of a choice. What it tells the gateway, which holds
   * it to its own ceiling besides.
   */
  #allowance(rule: Rule, scope: RuleScope): Record<string, number> {
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
    count(rule.then, 1);
    count(rule.otherwise ?? [], 1);
    return counts;
  }

  /** Seconds a step's expression says, held to what the language allows. */
  #seconds(expr: Expr, scope: RuleScope, max: number): number | null {
    const value = evaluateNow(expr, scope);
    return typeof value === 'number' && value >= 1 ? Math.min(value, max) : null;
  }

  /**
   * Steps, in order, as it acts. `then` and a choice's or watch's steps in it
   * stop at the first that does not succeed; `otherwise` tries every one
   * whatever the others do, and is not stopped; a retry stops where it
   * cannot go on.
   */
  async #walk(live: LiveRun, steps: readonly Step[], depth: number, within: string | null, mode: 'then' | 'retry' | 'otherwise'): Promise<Walked> {
    const scope = () => this.#context.scope(live.automation, live.rule, undefined, live.trigger);
    const stopping = () => live.stoppedBy !== null && mode !== 'otherwise';
    let result: Walked = 'ok';
    for (const step of steps) {
      if (stopping()) return 'stopped';
      const kind = stepKind(step);
      let walked: Walked = 'ok';
      /** The step in words, as its plan shows it. */
      const what = () => describeSteps({ ...live.rule, then: [step], otherwise: [] }, this.#context.settled(live.automation, live.rule), (role) => scope().name(role), this.#context.vocabulary(live.automation)).steps[0]!.text;
      // A choice its owner already made is no step of its own: the steps it chose are taken in its place.
      const chosen = 'choose' in step ? settledChoice(live.rule, step, this.#context.settled(live.automation, live.rule)) : null;

      // Each kind its own way of being taken — every kind, or this does not compile (kinds/steps.ts).
      if (chosen) walked = await this.#walk(live, chosen, depth, within, mode);
      else if ('command' in step) walked = await this.#command(live, step.command, depth, within, mode === 'otherwise');
      else if ('write' in step) walked = await this.#write(live, step.write, depth, within, what());
      else if ('start' in step) walked = await this.#startStep(live, step.start, depth, within, what(), mode);
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
        const came = await this.#until(live, step.waitUntil.condition, seconds);
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
          const came = await this.#until(live, condition, seconds);
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
          const retried = await this.#walk(live, retry, depth + 1, `Try ${attempt + 1} of ${tries}`, 'retry');
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
        walked = await this.#walk(live, branch, depth + 1, holds === true ? 'Then' : 'Otherwise', mode);
      } else if ('watch' in step) {
        const seconds = this.#seconds(step.watch.for, scope(), SEQUENCE_LIMITS.waitSeconds) ?? 1;
        const entry = this.#add(live, { kind, depth, within, what: what(), outcome: 'waiting', detail: 'Watching', until: this.#after(seconds) });
        const held = await this.#hold(live, step.watch.condition, seconds, mode === 'otherwise');
        if (held.outcome === 'stopped') {
          this.#end(live, entry, 'stopped', `Stopped by ${live.stoppedBy}`);
          walked = 'stopped';
        } else {
          const stayed = held.outcome === 'held';
          this.#end(live, entry, stayed ? 'met' : 'not-met', `${stayed ? `It stayed so for ${secondsText(seconds)}` : `It did not, after ${secondsText(held.seconds)}`}${held.saw ? ` — ${held.saw}` : ''}`);
          walked = await this.#walk(live, stayed ? (step.watch.then ?? []) : (step.watch.else ?? []), depth + 1, stayed ? 'It stayed so' : 'It did not', mode);
        }
      } else {
        // A kind the language has and this has no way to take: never silently another.
        const unknown: never = step;
        throw new Error(`No way to take a step of kind ${kind}: ${JSON.stringify(unknown)}`);
      }

      if (walked === 'ok') continue;
      if (mode === 'otherwise') {
        result = walked === 'failed' ? 'failed' : result;
        continue;
      }
      return walked;
    }
    return result;
  }

  /** A command, through the gateway, with the run's allowance: one step. */
  async #command(live: LiveRun, command: Command, depth: number, within: string | null, regardless: boolean): Promise<Walked> {
    const scope = this.#context.scope(live.automation, live.rule, undefined, live.trigger);
    const planned = await this.#context.planCommand(live.automation, command, scope);
    if ('unknown' in planned) {
      this.#add(live, { kind: 'command', depth, within, what: `Send ${planned.unknown}`, outcome: 'failed', detail: 'Could not tell what to send', until: null });
      return 'failed';
    }
    const entry = this.#add(live, { kind: 'command', depth, within, what: capitalise(planned.what), outcome: 'waiting', detail: 'Sending', until: null });
    // Why, and what it read to decide: what the device's timeline says the command was for.
    const saw = live.run.saw;
    const reason = `${live.automation.name}: ${live.run.why}${saw.length ? ` (${saw.join('; ')})` : ''}`;
    const send = async (): Promise<GatewayResult> => {
      try {
        return await this.deps.gateway.execute({
          deviceId: planned.binding.device,
          part: planned.binding.part,
          capability: planned.capability,
          command: planned.command,
          args: planned.args,
          reason,
          actor: 'automation',
          by: actorOf(live.automation),
          run: { id: live.id, askedBy: live.asker?.actor ?? null, switches: live.allowance[planned.role] ?? 1 },
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
  async #write(live: LiveRun, write: Write, depth: number, within: string | null, what: string): Promise<Walked> {
    const value = await evaluate(write.value, this.#context.scope(live.automation, live.rule, undefined, live.trigger), []).catch(() => null);
    const binding = live.automation.roles[write.role];
    const device = binding ? this.deps.device(binding) : null;
    const entry = this.#add(live, { kind: 'write', depth, within, what, outcome: 'waiting', detail: 'Setting', until: null });
    if (!binding || !device || device.removed) {
      this.#end(live, entry, 'failed', `${live.rule.roles[write.role]?.label ?? write.role}: no device`);
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
      result = await this.deps.gateway.write({ deviceId: binding.device, patch: { [key]: value }, actor: 'automation', by: actorOf(live.automation) });
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
    start: Extract<Step, { start: unknown }>['start'],
    depth: number,
    within: string | null,
    what: string,
    mode: 'then' | 'retry' | 'otherwise'
  ): Promise<Walked> {
    const seconds = start.andWait ? (this.#seconds(start.andWait, this.#context.scope(live.automation, live.rule, undefined, live.trigger), SEQUENCE_LIMITS.waitSeconds) ?? 1) : null;
    const entry = this.#add(live, { kind: 'start', depth, within, what, outcome: 'waiting', detail: 'Starting', until: seconds ? this.#after(seconds) : null });
    const target = live.automation.starts[start.role];
    const automation = target ? this.deps.store.get(target) : null;
    if (!automation) {
      this.#end(live, entry, 'failed', 'There is no automation to start: it was deleted');
      return 'failed';
    }
    let started: { begun: Promise<AutomationRun>; ended: Promise<AutomationRun> };
    try {
      started = this.#start(automation, { asker: live.asker, from: live });
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
      this.#end(live, entry, acted ? 'done' : 'failed', `It ${acted ? 'ran' : 'did not succeed'}: ${lowerFirst(came.run.summary)}`);
      return acted ? 'ok' : 'failed';
    }
    // Stopped while it waits: what it waits on stops too. Or the wait ran out: it goes on, and this does not.
    const child = this.#live.get(automation.id);
    if (came && came.slept === 'stopped') {
      // Stopped by the run that started it: "Stopped by “Morning” after it …".
      if (child) this.#stopLive(child, quoted(live.automation.name));
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
    const done = steps.filter((step) => ACTS.has(step.kind) && (step.outcome === 'done' || step.outcome === 'already' || step.outcome === 'unverified') && !step.within?.startsWith('Try'));
    // What it changed: what was already so is no deed of its own.
    const changed = done.filter((step) => step.outcome !== 'already').map((step) => lowerFirst(pastOf(step.what)));
    const made = steps.filter((step) => step.kind === 'ensure' && step.outcome === 'met').map((step) => step.detail);
    const afterwards = later.filter((step) => ACTS.has(step.kind) && (step.outcome === 'done' || step.outcome === 'already'));
    const then = afterwards.length ? `; then ${afterwards.map((step) => lowerFirst(pastOf(step.what))).join(', ')}` : '';
    if (walked === 'stopped') return `Stopped by ${live.stoppedBy}${changed.length ? ` after it ${changed.join(', ')}` : ''}${then}`;
    if (walked === 'failed') {
      const failing = steps.find((step) => step.depth === 0 && (step.outcome === 'timed-out' || step.outcome === 'failed' || step.outcome === 'refused')) ?? steps.find((step) => step.outcome === 'failed' || step.outcome === 'refused');
      return `Did not succeed: ${failing ? `${lowerFirst(failing.what)} — ${lowerFirst(failing.detail)}` : 'a step did not'}${then}`;
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
  async #wouldDo(automation: AutomationRecord, rule: Rule, scope: RuleScope): Promise<RunStep[] | { unknown: string }> {
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
          const value = await evaluate(step.write.value, scope, []).catch(() => null);
          const binding = automation.roles[step.write.role];
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
    return (await visit(rule.then)) ?? steps;
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

  /** Keeps what a condition reads fresh while a step waits on it: its holders ask their devices more often, until then. */
  #freshen(live: LiveRun, condition: Expr, seconds: number): void {
    const { reads, reaches } = ruleUses({ ...live.rule, when: [], then: [{ waitUntil: { condition, atMost: { value: 1 } } }], otherwise: [] });
    const until = this.#context.clock.now() + seconds * 1000 + 5_000;
    for (const role of new Set([...reads.map((read) => read.role), ...reaches])) {
      const binding = live.automation.roles[role];
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
  #readSince(live: LiveRun, condition: Expr): boolean {
    if (!live.changedAt) return true;
    const { reads, reaches } = ruleUses({ ...live.rule, when: [], then: [{ waitUntil: { condition, atMost: { value: 1 } } }], otherwise: [] });
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
      const binding = live.automation.roles[role];
      const heard = binding ? heardFrom(binding.device) : null;
      // One that says nothing at all is judged by its connection, as it is.
      return heard === null || heard > live.changedOrder;
    });
    if (!reachedSince) return false;
    return reads.every(({ role, means }) => {
      const binding = live.automation.roles[role];
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
  async #until(live: LiveRun, condition: Expr, seconds: number): Promise<{ outcome: 'met' | 'timed-out' | 'stopped'; seconds: number; saw: string }> {
    this.#freshen(live, condition, seconds);
    const started = this.#context.clock.now();
    const unit = 1000;
    for (;;) {
      const saw: string[] = [];
      // Met only on readings taken since the run last changed something.
      const holds = this.#readSince(live, condition) ? evaluateNow(condition, this.#context.scope(live.automation, live.rule, undefined, live.trigger), saw) : null;
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
  async #hold(live: LiveRun, condition: Expr, seconds: number, regardless: boolean): Promise<{ outcome: 'held' | 'broke' | 'stopped'; seconds: number; saw: string }> {
    this.#freshen(live, condition, seconds + SETTLE_AT_MOST_SECONDS);
    const unit = 1000;
    // Watched from the first readings taken since the run last changed something — or, if none come, from when it gave up waiting for them.
    const settling = this.#context.clock.now();
    while (!this.#readSince(live, condition) && (this.#context.clock.now() - settling) / unit < SETTLE_AT_MOST_SECONDS) {
      if ((await this.#sleep(live, LOOK_EVERY_SECONDS, regardless)) === 'stopped') return { outcome: 'stopped', seconds: 0, saw: '' };
    }
    const started = this.#context.clock.now();
    for (;;) {
      const saw: string[] = [];
      const holds = evaluateNow(condition, this.#context.scope(live.automation, live.rule, undefined, live.trigger), saw);
      const elapsed = (this.#context.clock.now() - started) / unit;
      live.log?.look();
      if (holds !== true) return { outcome: 'broke', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if (elapsed >= seconds) return { outcome: 'held', seconds: elapsed, saw: [...new Set(saw)].join('; ') };
      if ((await this.#sleep(live, Math.min(LOOK_EVERY_SECONDS, seconds - elapsed), regardless)) === 'stopped') return { outcome: 'stopped', seconds: elapsed, saw: '' };
    }
  }
}
