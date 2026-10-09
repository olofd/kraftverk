# @kraftverk/script-language

## What it is

The script editor's language service ([docs/PLAN-SCRIPTS.md](../../docs/PLAN-SCRIPTS.md)
§11.2). It is TypeScript 6's language service, the last TypeScript with a
JavaScript API, run over files kept in memory:
- the script being written;
- the types it is written against: `typesOf` of `@kraftverk/script`, the
  SDK and one home's devices;
- the language's own declarations, ES2022 and no DOM.

## What it does — and does not

- **Does:** `createScriptLanguage(libraries)` answers, for the script as it
  is now:
  - what is wrong with it, by offset, line and column;
  - what may be written at an offset: a device's key, a capability's
    commands, the SDK's names;
  - what a name is, with its words, on hover.

  `types(declarations)` gives it a home's types, as the hub makes them
  (`scripts.types()`).
- **Does not:**
  - run anywhere but where the editor is. In a browser that is a worker of
    its own (`client/src/platform/script/worker.ts`, built beside the app
    by `client/scripts/build-home-worker.mjs`), never the hub: the hub
    never checks types;
  - fetch anything: the library declarations are given it, from a
    `lib.json` the build writes beside the worker.

## Where it fits

An edge package, beside `@kraftverk/api-client` and `@kraftverk/ui`: the
app's, never the hub's. It imports `@kraftverk/script` and TypeScript 6,
pinned here while the rest of the repository builds with TypeScript 7.
The app's script editor (`ScriptEditor.web.tsx`) reaches it over a message
port (`@kraftverk/message-port`), as `language`.

## Why a package of its own

The compiler is some megabytes, and the hub must never carry it. Held
apart, only the editor's worker bundles it. And the same service can later
run in a phone's WebView, or on a server for a place that cannot run it
itself, behind the same interface.
