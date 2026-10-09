import { ApiError, type Caller, type KraftverkApi, type ScriptTried, type ScriptView } from '@kraftverk/api-contract';
import type { ScriptProblem } from '@kraftverk/automation';
import { typesOf } from '@kraftverk/script';
import type { ScriptRecord } from '@kraftverk/store';

import type { Hub } from '../node/hub.ts';
import { scriptHome } from '../scripts/world.ts';
import { runScriptStep, type Said } from '../scripts/runner.ts';
import { actorOf } from './caller.ts';
import { checkKey, scopeOf } from './scope.ts';

/*
  The family's scripts in TypeScript, as a family answers them
  (docs/PLAN-SCRIPTS.md): each by its key, its source as written, and what
  this place's engine reads from it. A script is kept only when it reads
  without a problem, and every change is on the timeline. An automation runs
  one from its script step; a person tries one of its steps from the editor
  (`run`), as themselves.
*/

/** A problem as a refusal says it: at its line and column, when it has them. */
const problemText = (problem: ScriptProblem): string => (problem.line ? `Line ${problem.line}${problem.column ? `, column ${problem.column}` : ''}: ${problem.message}` : problem.message);

const NAME_MOST = 60;

/** The longest a step tried from the editor may take, waits and all. */
const TRY_SECONDS = 60;

export function scriptsApi(hub: Hub, caller: Caller): Pick<KraftverkApi, 'scripts'> {
  const { record } = scopeOf(hub, caller);
  const { scripts } = hub;

  const viewOf = (script: ScriptRecord): ScriptView => {
    const read = scripts.readKept(script);
    return { id: script.id, key: script.key, name: script.name, source: script.source, shape: read.shape, problems: read.problems, updatedAt: script.updatedAt, updatedBy: script.updatedBy.name };
  };
  const scriptOf = (id: string): ScriptRecord => {
    const script = scripts.store.get(id);
    if (!script) throw new ApiError('not-found', 'No such script');
    return script;
  };
  const nameOf = (given: string): string => {
    const name = given.trim();
    if (!(name.length >= 1 && name.length <= NAME_MOST)) throw new ApiError('invalid', `A script's name is 1 to ${NAME_MOST} characters`);
    return name;
  };
  /** A source to keep: one this place reads without a problem, or a refusal with each problem. */
  const readable = (source: string): void => {
    if (!scripts.engine) throw new ApiError('unavailable', 'Scripts cannot run here: this place has no engine for them');
    const { problems } = scripts.read(source);
    if (problems.length) throw new ApiError('invalid', problems.length === 1 ? `The script cannot be kept: ${problemText(problems[0]!)}` : `The script cannot be kept: it has ${problems.length} problems`, { problems: problems.map(problemText) });
  };

  return {
    scripts: {
      list: async () => scripts.store.list().map(viewOf),

      get: async (id) => viewOf(scriptOf(id)),

      async create(input) {
        const name = nameOf(input.name);
        if (input.key !== undefined) checkKey(input.key, !scripts.store.keyFree(input.key), 'script', 'tidy-up');
        readable(input.source);
        const script = scripts.store.add({ ...(input.key !== undefined ? { key: input.key } : {}), name, source: input.source }, actorOf(caller), new Date().toISOString());
        record('script.added', 'script', script.id, `Wrote the script "${script.name}"`, { key: script.key });
        return viewOf(script);
      },

      async update(id, changes) {
        const was = scriptOf(id);
        const name = changes.name === undefined ? undefined : nameOf(changes.name);
        if (changes.key !== undefined && changes.key !== was.key) checkKey(changes.key, !scripts.store.keyFree(changes.key, id), 'script', 'tidy-up');
        if (changes.source !== undefined && changes.source !== was.source) readable(changes.source);
        const script = scripts.store.update(id, { ...(name !== undefined ? { name } : {}), ...(changes.key !== undefined ? { key: changes.key } : {}), ...(changes.source !== undefined ? { source: changes.source } : {}) }, actorOf(caller), new Date().toISOString())!;
        const said = [
          ...(script.name !== was.name ? [`renamed it "${script.name}"`] : []),
          ...(script.key !== was.key ? [`its key is "${script.key}"`] : []),
          ...(script.source !== was.source ? ['changed what it says'] : []),
        ];
        if (said.length) record('script.changed', 'script', id, `The script "${was.name}": ${said.join(', ')}`, { key: script.key });
        return viewOf(script);
      },

      async remove(id) {
        const script = scriptOf(id);
        scripts.store.remove(id);
        scripts.forget(id);
        record('script.removed', 'script', id, `Removed the script "${script.name}"`, { key: script.key });
      },

      async types() {
        return typesOf(scriptHome(hub));
      },

      async run(input) {
        if (!scripts.engine) throw new ApiError('unavailable', 'Scripts cannot run here: this place has no engine for them');
        const read = scripts.read(input.source);
        if (!read.compiled || !read.shape) throw new ApiError('invalid', 'It does not read yet', { problems: read.problems.map(problemText) });
        const declared = read.shape.steps[input.step];
        if (!declared) throw new ApiError('not-found', `It has no step "${input.step}"`);
        // What it remembers, as it starts: nothing kept, so each try begins afresh.
        const memory = Object.fromEntries(Object.entries(declared.memory.fields).flatMap(([key, field]) => (field.default === undefined ? [] : [[key, field.default]])));
        const lines: Said[] = [];
        const asked: ScriptTried['asked'] = [];
        const done = await runScriptStep(hub, {
          script: { name: 'The script', compiled: read.compiled, shape: read.shape, calls: read.calls },
          step: input.step,
          inputs: input.inputs,
          memory,
          caller,
          actor: actorOf(caller),
          homeId: null,
          cause: [],
          deadline: hub.clock.now() + TRY_SECONDS * 1000,
          signal: new AbortController().signal,
          say: (line) => void lines.push(line),
          yes: input.yes ?? {},
          asked: (need) => void asked.push(need),
        });
        return 'fault' in done ? { lines, answer: null, memory, fault: done.fault, asked } : { lines, answer: done.answer, memory: done.memory, fault: null, asked };
      },

      async check(source) {
        if (!scripts.engine) throw new ApiError('unavailable', 'Scripts cannot run here: this place has no engine for them');
        const { shape, problems } = scripts.read(source);
        return { shape, problems };
      },
    },
  };
}
