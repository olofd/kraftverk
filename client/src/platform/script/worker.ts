import { serveApi, type MessageEnd } from '@kraftverk/message-port';
import { createScriptLanguage, type ScriptLanguage } from '@kraftverk/script-language';

/*
  The script editor's language service, in a worker of its own (docs/PLAN-
  SCRIPTS.md §11.2): TypeScript 6 checking, completing, explaining and
  formatting a script as it is typed, off the page's thread. Bundled on its own beside
  the app (scripts/build-home-worker.mjs), with the language's own
  declarations beside it in lib.json — read from this app's origin, never
  fetched from anywhere else. Served to the editor over a message port, as
  `language`.
*/

const scope = globalThis as unknown as MessageEnd;

/** The service, once its declarations are read: what is asked before then waits for it. */
const ready: Promise<ScriptLanguage> = fetch(new URL('./lib.json', import.meta.url))
  .then((answer) => answer.json() as Promise<Record<string, string>>)
  .then((libraries) => createScriptLanguage(libraries));

const language: ScriptLanguage = {
  types: async (declarations) => (await ready).types(declarations),
  problems: async (source) => (await ready).problems(source),
  complete: async (source, at) => (await ready).complete(source, at),
  hover: async (source, at) => (await ready).hover(source, at),
  format: async (source) => (await ready).format(source),
};

serveApi(language, scope, 'language');
