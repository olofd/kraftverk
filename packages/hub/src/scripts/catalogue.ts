import type { ScriptProblem } from '@kraftverk/automation';
import { readScript, type ReadScript, type ScriptEngine } from '@kraftverk/script';
import type { ScriptRecord, ScriptStore } from '@kraftverk/store';

/*
  The family's scripts, as this place holds them (docs/PLAN-SCRIPTS.md §4.3):
  each kept script's source, and what this place's engine reads from it —
  compiled, and what it declares — read once and again only when its source
  changes. What a script reads as is never kept: it is read from its source
  wherever the home runs.
*/

/** What a script reads as where there is no engine: nothing, and why. */
const NO_ENGINE: ScriptProblem = { message: 'Scripts cannot run here: this place has no engine for them', line: null, column: null };

export class ScriptCatalogue {
  readonly store: ScriptStore;
  /** What runs this place's scripts; none where it has no engine. */
  readonly engine: ScriptEngine | null;
  /** What each kept script reads as, by its id, with the source it was read from. */
  readonly #read = new Map<string, { source: string; read: ReadScript }>();

  constructor(store: ScriptStore, engine: ScriptEngine | null) {
    this.store = store;
    this.engine = engine;
  }

  /** A source as this place's engine reads it: what it declares, or its problems. Nothing kept. */
  read(source: string): ReadScript {
    return this.engine ? readScript(source, this.engine) : { compiled: null, shape: null, problems: [NO_ENGINE] };
  }

  /** What a kept script reads as now: read again only when its source has changed since. */
  readKept(script: ScriptRecord): ReadScript {
    const known = this.#read.get(script.id);
    if (known?.source === script.source) return known.read;
    const read = this.read(script.source);
    this.#read.set(script.id, { source: script.source, read });
    return read;
  }

  /** A script gone: what it read as goes with it. */
  forget(id: string): void {
    this.#read.delete(id);
  }
}
