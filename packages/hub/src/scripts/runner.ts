import { ApiError, type Caller, type KraftverkApi } from '@kraftverk/api-contract';
import { SCRIPT_LIMITS, type ScriptShape } from '@kraftverk/automation';
import type { ScriptRunner, ScriptStepDone, ScriptStepRequest } from '@kraftverk/automation-engine';
import { isPosition, type Value } from '@kraftverk/device-sdk';
import type { GatewayActor } from '@kraftverk/gateway';
import { loadScript, ScriptFault, type Compiled, type HostFunctions, type ReadScript, type Sandbox } from '@kraftverk/script';

import { GATES } from '../api/gate.ts';
import type { Hub } from '../node/hub.ts';
import { scriptDevice, scriptHomes, scriptPeople } from './world.ts';

/*
  The family's scripts, run for its automations (docs/PLAN-SCRIPTS.md §7,
  §10): one of a script's steps for a step of a run, in a sandbox of its
  own, as a caller of the hub — the automation, for the person whose yes it
  acts on, with their role — held to its budgets; and one of its functions,
  at once and pure, for a condition.

  What a step may ask of the home crosses as text, through four host
  functions and nothing else: `__log`, `__read` (the home as it is, at
  once), `__call` (one call of the API, through the gate, as any caller's
  is) and `__wait` (a pause on the home's clock). What it does is said
  beneath its step in the run's log, as it does it.
*/

/** Names that are a JavaScript object's, never the API's: not a way in. */
const NOT_CALLS = new Set(['__proto__', 'constructor', 'prototype']);

/** The function a path names on the API, on the object it belongs to — only the interface's own. */
const callAt = (api: KraftverkApi, path: readonly string[]): { owner: object; fn: (...args: unknown[]) => unknown } | null => {
  let owner: unknown = null;
  let at: unknown = api;
  for (const key of path) {
    if (NOT_CALLS.has(key) || typeof at !== 'object' || at === null || !Object.prototype.hasOwnProperty.call(at, key)) return null;
    owner = at;
    at = (at as Record<string, unknown>)[key];
  }
  return typeof at === 'function' && owner ? { owner, fn: at as (...args: unknown[]) => unknown } : null;
};

/** A refusal as it crosses back: what the guest SDK throws again as a `KraftverkError`. */
const refusalText = (error: unknown): string =>
  JSON.stringify(error instanceof ApiError ? { kind: error.kind, message: error.message, problems: error.problems } : { kind: 'failed', message: error instanceof Error ? error.message : String(error) });

/** A fault as the run's log says it: what, and at which line of the script. */
const faultWords = (fault: ScriptFault): string => `${fault.message}${fault.line ? ` (line ${fault.line})` : ''}`;

/** What a call the gate counts as acting did, in words for the run's log. */
export type Said = { what: string; outcome: 'done' | 'refused' | 'failed' | 'unverified'; detail: string | null };

/** What a device reports now, by key — never where it is: a position is not a script's to read. */
const readingsOf = (hub: Hub, id: string): Record<string, Value> =>
  Object.fromEntries((hub.sessions.get(id as never)?.readings() ?? []).filter((reading) => !isPosition(reading.value)).map((reading) => [reading.key, reading.value as Value]));

/** The world as it is now, as a step asks it: at once, between its waits — for a run at a home. */
const answerRead = (hub: Hub, text: string, homeId: string | null): string => {
  const query = JSON.parse(text) as { devices?: true; reading?: [string, string]; readings?: string; people?: true; homes?: true; home?: true; at?: [string, string]; occupied?: [string, string]; mode?: [string, string] };
  if (query.devices) return JSON.stringify(hub.catalog.list().flatMap((record) => scriptDevice(hub, record.id) ?? []));
  if (query.people) return JSON.stringify(scriptPeople(hub));
  if (query.homes) return JSON.stringify(scriptHomes(hub));
  if (query.home) return JSON.stringify(hub.world.home(homeId));
  if (query.at) return JSON.stringify(hub.world.whoAt({ kind: query.at[0] as never, id: query.at[1] }));
  if (query.occupied) return JSON.stringify(hub.world.occupied({ kind: query.occupied[0] as never, id: query.occupied[1] }));
  if (query.mode) return JSON.stringify(hub.world.mode(query.mode[0], query.mode[1] as never));
  if (query.readings) return JSON.stringify(readingsOf(hub, query.readings));
  if (query.reading) return JSON.stringify(readingsOf(hub, query.reading[0])[query.reading[1]] ?? null);
  throw new Error('Not something a script can read');
};

/** A script read, ready to run: its JavaScript, what it declares, how each export is called, and what it is called. */
type Runnable = { name: string; compiled: Compiled; shape: ScriptShape; calls: ReadScript['calls'] };

/**
 * One step of a script, run: as an automation's step, or tried from the
 * editor by a person. As `caller` through the gate, its acts said as
 * `actor`'s, at `homeId`; its waits ended by `deadline` and `signal`.
 */
export type StepRun = {
  script: Runnable;
  /** Which of its steps: its only one, when null. */
  step: string | null;
  inputs: Record<string, Value>;
  memory: Record<string, Value>;
  caller: Caller;
  actor: GatewayActor;
  homeId: string | null;
  /** The automations whose runs led here, outermost first. */
  cause: readonly string[];
  deadline: number;
  signal: AbortSignal;
  say: (line: Said) => void;
  /** A person's yes to commands that ask for one, by what each is (`yesKey`): given with each as it is sent. */
  yes?: Readonly<Record<string, string>>;
  /** A command refused until a person says yes: what it is, the gateway's token for that yes, and why it asks. */
  asked?: (need: { key: string; token: string; what: string }) => void;
};

/** What a command is, for a yes to it: its device, part, capability and command. */
const yesKey = (args: readonly unknown[]): string => args.slice(0, 4).map(String).join('/');

/** One of a script's steps, run in a sandbox of its own and held to its budgets: its answer and its memory after, or why it failed. */
export async function runScriptStep(hub: Hub, run: StepRun): Promise<ScriptStepDone> {
  const engine = hub.scripts.engine;
  if (!engine) return { fault: 'This place runs no scripts' };
  const { script, say } = run;
  // Its only step, when none is said; given its inputs by name, and what it remembers where it takes it.
  const steps = Object.keys(script.shape.steps);
  const name = run.step ?? (steps.length === 1 ? steps[0]! : null);
  const call = name === null ? undefined : script.calls[name];
  if (name === null || !call || !script.shape.steps[name]) return { fault: name === null ? `Which of its steps? It has ${steps.join(', ') || 'none'}` : `${script.name} has no step "${name}"` };
  const args = call.params.map((param, at) => (at === call.memory ? run.memory : (run.inputs[param] ?? null)));
  const api = hub.as(run.caller);
  let calls = 0;
  let acts = 0;
  let lines = 0;
  let quietLines = 0;
  const budget = () => {
    if (sandbox.cpuMs > SCRIPT_LIMITS.stepCpuMs) throw new Error(`It worked for more than ${SCRIPT_LIMITS.stepCpuMs / 1000} s: stopped`);
  };

  const host: HostFunctions = {
    sync: {
      __log: (text) => {
        if (lines++ < SCRIPT_LIMITS.logLines) say({ what: text.slice(0, 500), outcome: 'done', detail: null });
        else quietLines++;
        return '';
      },
      __read: (text) => answerRead(hub, text, run.homeId),
    },
    async: {
    __call: async (text) => {
          budget();
          const { path, args } = JSON.parse(text) as { path: string[]; args: unknown[] };
          if (++calls > SCRIPT_LIMITS.calls) throw new Error(refusalText(new ApiError('forbidden', `A script's step calls the home at most ${SCRIPT_LIMITS.calls} times`)));
          // What the run itself does: tell people, set a mode — as its steps do.
          if (path[0] === 'run') return JSON.stringify(runCall(path[1] ?? '', args[0] as Record<string, unknown>));
          const at = callAt(api, path);
          const gate = (GATES as Record<string, { kind: string } | undefined>)[path.join('.')];
          if (!at || !gate) throw new Error(refusalText(new ApiError('not-found', `The home has no "${path.join('.')}"`)));
          if (gate.kind !== 'read' && ++acts > SCRIPT_LIMITS.acts) throw new Error(refusalText(new ApiError('forbidden', `A script's step changes something at most ${SCRIPT_LIMITS.acts} times`)));
          try {
            const isCommand = path.join('.') === 'devices.command';
            // A yes the person gave to this command, from the try before: with it, as theirs.
            const yes = isCommand ? run.yes?.[yesKey(args)] : undefined;
            if (yes) args[4] = { ...(args[4] as object), confirmation: yes };
            const answer = await at.fn.apply(at.owner, args);
            const token = isCommand ? (answer as { needsConfirmation?: string } | null)?.needsConfirmation : undefined;
            if (token) run.asked?.({ key: yesKey(args), token, what: (answer as { detail?: string }).detail ?? 'It asks for a yes' });
            if (gate.kind !== 'read') say(saidOf(path.join('.'), args, answer));
            return JSON.stringify(answer ?? null);
          } catch (error) {
            if (gate.kind !== 'read') say({ what: path.join('.'), outcome: 'refused', detail: error instanceof Error ? error.message : String(error) });
            throw new Error(refusalText(error));
          }
        },
        __wait: (text) =>
          new Promise<string>((resolve, reject) => {
            const ms = Math.min(Math.max(0, Number(text) || 0), Math.max(0, run.deadline - hub.clock.now()));
            const timer = hub.clock.setTimeout(() => (run.signal.removeEventListener('abort', stopped), resolve('')), ms);
            const stopped = () => (hub.clock.clear(timer), reject(new Error(refusalText(new ApiError('conflict', 'Stopped')))));
            run.signal.addEventListener('abort', stopped, { once: true });
          }),
      },
    };

    /** What the run itself does, as its steps would: tell people, set a mode. */
    const runCall = (what: string, given: Record<string, unknown>): unknown => {
      if (what === 'notify') {
        const title = String(given.title ?? '').slice(0, 120);
        if (!title) throw new Error(refusalText(new ApiError('invalid', 'Telling someone says something: a title')));
        const people = Array.isArray(given.to) ? (given.to as string[]) : hub.world.members();
        const { told } = hub.world.notify(people, { title, text: typeof given.text === 'string' ? given.text.slice(0, 1000) : null, level: 'info', homeId: hub.world.home(run.homeId) }, run.actor);
        say({ what: `Told ${told.length === 1 ? (hub.world.personName(told[0]!) ?? 'someone') : `${told.length} people`}: “${title}”`, outcome: told.length ? 'done' : 'failed', detail: null });
        return { told };
      }
      if (what === 'setMode') {
        const home = typeof given.home === 'string' ? given.home : hub.world.home(run.homeId);
        if (!home) throw new Error(refusalText(new ApiError('not-found', 'There is no such home')));
        hub.world.setMode(home, String(given.mode), run.actor, run.cause);
        say({ what: `${hub.world.placeName({ id: home, kind: 'home' }) ?? 'The home'} is ${String(given.mode)} now`, outcome: 'done', detail: null });
        return { home, mode: given.mode };
      }
      throw new Error(refusalText(new ApiError('not-found', `A run does not "${what}"`)));
    };

    /** A call that changed something, said as the run's log says a step: a command by its device and what came of it. */
    const saidOf = (path: string, args: unknown[], answer: unknown): Said => {
      if (path === 'devices.command') {
        const [id, part, capability, command, body] = args as [string, string, string, string, { args?: Record<string, unknown> }];
        const device = hub.catalog.get(id as never);
        const result = answer as { outcome: string; detail?: string };
        const outcome = result.outcome === 'verified' ? 'done' : result.outcome === 'unverified' ? 'unverified' : result.outcome === 'refused' ? 'refused' : 'failed';
        const said = Object.entries(body?.args ?? {}).map(([name, value]) => `${name} ${JSON.stringify(value)}`).join(', ');
        return { what: `${device?.name ?? 'A device'}${part !== 'main' ? ` (${part})` : ''}: ${capability}.${command}${said ? ` ${said}` : ''}`, outcome, detail: result.detail ?? null };
      }
      return { what: path, outcome: 'done', detail: null };
    };

  const sandbox: Sandbox = engine.open({ memoryBytes: SCRIPT_LIMITS.stepMemoryBytes, stackBytes: SCRIPT_LIMITS.stepStackBytes, sliceMs: SCRIPT_LIMITS.sliceMs }, host);
  // Its run's deadline: what it waits for is refused then, as when its run is stopped.
  const deadline = new AbortController();
  const timer = hub.clock.setTimeout(() => deadline.abort(), Math.max(0, run.deadline - hub.clock.now()));
  const stop = () => deadline.abort();
  run.signal.addEventListener('abort', stop, { once: true });
  try {
    loadScript(sandbox, script.compiled);
    const answer = await sandbox.callAsync('__step', JSON.stringify({ name, args, memory: call.memory }), deadline.signal);
    if (quietLines) say({ what: `And ${quietLines} more line${quietLines === 1 ? '' : 's'} it said`, outcome: 'done', detail: null });
    if (answer.length > SCRIPT_LIMITS.answerBytes) return { fault: `It answered more than ${SCRIPT_LIMITS.answerBytes / 1024} KB` };
    const done = JSON.parse(answer) as { answer: Value | null; memory: Record<string, Value> };
    return { answer: done.answer, memory: done.memory };
  } catch (error) {
    if (error instanceof ScriptFault) {
      if (error.kind === 'stopped' && !run.signal.aborted) return { fault: "It ran past its run's time, and was stopped" };
      // A refusal it did not catch: said in its own words.
      const refused = /^\{"kind"/.test(error.message) ? (JSON.parse(error.message) as { message: string }).message : null;
      return { fault: refused ?? faultWords(error) };
    }
    return { fault: error instanceof Error ? error.message : String(error) };
  } finally {
    hub.clock.clear(timer);
    run.signal.removeEventListener('abort', stop);
    sandbox.dispose();
  }
}

export function scriptRunner(hub: Hub): ScriptRunner {
  const { scripts } = hub;

  /** A kept script as it reads here: ready to run, or why it cannot. */
  const readable = (scriptId: string) => {
    const script = scripts.store.get(scriptId);
    if (!script) return { ok: false, problem: 'The script it names is gone' } as const;
    if (!scripts.engine) return { ok: false, problem: 'This place runs no scripts' } as const;
    const read = scripts.readKept(script);
    if (!read.compiled || !read.shape) return { ok: false, problem: `${script.name} cannot run: ${read.problems.map((each) => each.message).join('; ')}` } as const;
    return { ok: true, runnable: { name: script.name, compiled: read.compiled, shape: read.shape, calls: read.calls } satisfies Runnable } as const;
  };

  return {
    shape(scriptId) {
      const read = readable(scriptId);
      return read.ok ? read.runnable.shape : null;
    },

    name: (scriptId) => scripts.store.get(scriptId)?.name ?? null,

    fn(scriptId, fn, args) {
      const read = readable(scriptId);
      if (!read.ok) return { value: null, detail: read.problem };
      // Pure: a sandbox of its own for the call, nothing of the home lent — it cannot keep anything from one look to the next.
      const sandbox = scripts.engine!.open({ memoryBytes: SCRIPT_LIMITS.functionMemoryBytes, stackBytes: 256 * 1024, sliceMs: SCRIPT_LIMITS.functionMs }, { sync: { __log: () => '' }, async: {} });
      try {
        loadScript(sandbox, read.runnable.compiled);
        const value = JSON.parse(sandbox.call('__fn', JSON.stringify({ name: fn, args }))) as Value | null;
        return { value, detail: null };
      } catch (error) {
        return { value: null, detail: error instanceof ScriptFault ? faultWords(error) : String(error) };
      } finally {
        sandbox.dispose();
      }
    },

    async step(request: ScriptStepRequest): Promise<ScriptStepDone> {
      const read = readable(request.scriptId);
      if (!read.ok) return { fault: read.problem };
      const { automation, run } = request;
      return runScriptStep(hub, {
        script: read.runnable,
        step: request.step ?? null,
        inputs: request.inputs,
        memory: request.memory,
        // As the automation, for the person whose yes it acts on — the one who started this run, if a person did.
        caller: {
          kind: 'automation',
          id: automation.id,
          name: automation.name,
          for: run.askedBy?.kind === 'person' ? (run.askedBy.id ?? automation.actingFor) : automation.actingFor,
          run: { id: run.id, askedBy: run.askedBy?.kind ?? null },
        },
        actor: { kind: 'automation', id: automation.id, name: automation.name },
        homeId: automation.homeId,
        cause: run.cause,
        deadline: request.deadline,
        signal: request.signal,
        say: request.say,
      });
    },
  };
}
