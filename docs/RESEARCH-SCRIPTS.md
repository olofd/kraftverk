# Scripts in TypeScript: research, and a proposal

**Status:** research and a proposal, 2026-10-09. Nothing here is built. It
replaces the one paragraph phase C4 had in
[PLAN-AUTOMATION-LANGUAGE.md](PLAN-AUTOMATION-LANGUAGE.md) ("a sandboxed
opt-in script step") with what the owner asked for: scripts written in
TypeScript, edited in the app with completion and type checking, as
powerful as a person in kraftverk — able to start any device and do
anything a user can do — and running wherever a home runs: the server,
the browser, and the phone's own app (React Native, Hermes), with no
server needed.

## 1. What the owner asked for

1. **TypeScript**, typed by the home itself: `charger.power` is a power in
   W, `charger.switch.set({ on: true })` completes, a key that names no
   device is an error while it is typed.
2. **An editor in the app** with completion, hover, and problems marked
   where they are — on the web and on the phone.
3. **Power**: a script can do anything a user can — any device, any
   setting, modes, notifications, other automations, the home's map —
   not only the roles its automation names.
4. **Everywhere a home runs**: Bun on a server, the browser (the hub in a
   worker), and React Native on the phone (Hermes, Expo SDK 57, RN 0.86,
   a development build).
5. **Safe**: every physical act through the gateway, as ever; no network,
   no files; limits on time, memory and how much a run may do.

## 2. What the research found

The full findings, with sources, are summarised here; links are to what
was read on 2026-10-09.

### 2.1 The sandbox: QuickJS everywhere

| Option | Bun | Browser | Phone (Hermes) | Limits | Verdict |
| --- | --- | --- | --- | --- | --- |
| **QuickJS-NG as WebAssembly** — [`quickjs-emscripten-core`](https://github.com/justjake/quickjs-emscripten) + `@jitl/quickjs-ng-wasmfile-release-sync` (~0.5 MB wasm) | yes | yes (in a worker) | **no** — Hermes has no usable WebAssembly | CPU (interrupt handler), memory, stack | **Server and web** |
| **QuickJS-NG as a native module** (JSI / Expo module, vendoring the same QuickJS) | — | — | yes | the same three, from QuickJS's C API | **Phone** |
| SES / Hardened JS | yes | yes | `lockdown` only, no `Compartment` | none for CPU or loops | rejected |
| Web Workers alone | partly | yes | no Workers in RN | `terminate()` only, no memory limit, `fetch` stays | an outer layer, not the sandbox |
| A second Hermes runtime | — | — | possible in custom C++ (`hardenedHermesRuntimeConfig`, `watchTimeLimit`) | yes | a different engine from the other two: not chosen |
| ShadowRealm, `isolated-vm`, Javy, Extism, Porffor, Boa | — | — | — | — | not usable here |

- **Hermes and WebAssembly.** Hermes' lead [announced WebAssembly
  support](https://tmikov.blogspot.com/2026/02/webassembly-comes-to-hermes_01829874520.html)
  in February 2026 as an early preview "not yet ready for production"; no
  React Native release through 0.87 ships it. Treat it as absent; a one-line
  `typeof WebAssembly` on the development build settles it.
- **Native QuickJS for React Native.** The closest existing module,
  [`react-native-native-quickjs`](https://github.com/swittk/react-native-native-quickjs),
  has time, memory and stack limits, cancelling, and async host functions
  — but is days old and unproven. Plan to **own the module**: an Expo
  module of a few hundred lines of C++ around QuickJS-NG, the same engine
  version as the WebAssembly build, so a script behaves the same on every
  platform.
- **Speed.** QuickJS is an interpreter, tens of times slower than a JIT;
  for automation code — milliseconds of logic between waits — it does not
  matter.

### 2.2 TypeScript inside the app

- **Stripping types to run a script** is all the hub needs:
  [`sucrase`](https://www.npmjs.com/package/sucrase) (1.1 MB, pure
  JavaScript) runs on Bun, in a worker and on Hermes. `esbuild-wasm`,
  `@swc/wasm-typescript` and `amaro` need WebAssembly, so not on the phone.
- **Type checking** needs the JavaScript TypeScript compiler. **TypeScript
  7 (the Go port) has no JavaScript API** — kraftverk's own build uses it,
  but the editor cannot. Use the TypeScript 6 line,
  [`@typescript/typescript6`](https://www.npmjs.com/package/@typescript/typescript6)
  with [`@typescript/vfs`](https://www.npmjs.com/package/@typescript/vfs):
  about 1.6 MB gzipped, plus the `lib` declarations a script needs (ES2022,
  no DOM). It is the last JavaScript compiler; a move to TypeScript 7.1's
  API (a Go process over IPC) would come later, and only for the server.
- **On the phone,** running a 9 MB compiler in Hermes (no JIT) is not
  sensible: type checking runs where the editor does — in a WebView (§2.3).
  The hub itself never needs the type checker: types are for whoever
  writes, and the boundary is checked at run time anyway (§3.5).

### 2.3 The editor

- **CodeMirror 6** — already the app's YAML editor — with a TypeScript 6
  language service in a worker: completion, hover, lint, signature help.
  The archived [`@valtown/codemirror-ts`](https://github.com/val-town/codemirror-ts)
  (about 300 lines) shows the wiring; or
  [`@codemirror/lsp-client`](https://www.npmjs.com/package/@codemirror/lsp-client)
  with a small adapter. Monaco is 100 MB and does not suit touch screens.
- **On the phone: an Expo DOM component** (`'use dom'`): the same React
  component file renders as web on the web and inside a WebView in the
  native app, where JIT, WebAssembly and workers exist. The editor and its
  language service are one component for both. Unverified: a worker
  inside a DOM component on iOS and Android (a spike, §5).
- **Types the editor is given** are generated per automation and per home
  from what the home has, and loaded into the language service's virtual
  files — as Cloudflare's `wrangler types` generates a project's `Env`.

### 2.4 Prior art

| Platform | Language and sandbox | How devices are read and changed | Typings |
| --- | --- | --- | --- |
| Home Assistant (pyscript, AppDaemon) | Python, **no sandbox** | state reads; service calls; decorators for triggers | none in an editor |
| Homey (HomeyScript) | JavaScript, a 30 s limit, `fetch` allowed | async Web API calls | none |
| ioBroker | JavaScript and TypeScript, `node:vm` — **not a boundary** | `getState` from a cache, `setState` async (reads after writes go stale) | a bundled `.d.ts` |
| openHAB (JS Scripting) | GraalJS | `items.x.state` sync, `sendCommand` | a `.d.ts` on npm, for VS Code |
| Node-RED (function node) | JavaScript, `node:vm` | `msg`, `node.send`, contexts | a bundled Node `.d.ts`, often wrong |
| Shelly | Espruino on the device | `Shelly.call`, at most 5 timers and 5 calls | none |
| Val Town, Windmill | Deno; editor with a language server on a server | an exported function whose signature makes its form | from the server |

What to take: **one imported module** rather than loose globals; **device
state read synchronously** from a snapshot, refreshed after each `await`;
**actions as awaited requests** that answer with what came of them;
**triggers declared by the automation**, not subscribed to inside the
script; a **small store** with limits; **typings generated per
installation**. What to avoid: `node:vm` as a "sandbox", network access,
untyped globals, stale reads after writes.

## 3. A proposal for kraftverk

### 3.1 Where a script stands in an automation

Triggers stay the automation's — declared, explained, rehearsed, kept
across a restart. A script is what an automation **does**, or a value it
**works out**:

- **A script step** — `script: tidy-up` among its steps, with typed
  `inputs` and an `answer` — that may do anything a person may (§3.3),
  wait, and remember. It is a step like any: in its run's log, under its
  run's budgets, stopped when the run is.
- **A script function** — called in a condition or a value:
  `scripts.cheapest(prices, 3)`. Pure: it reads, it never acts or waits, so
  it can be looked at on every reading, in watch mode, and in a rehearsal
  on history. The same file may hold both.

Scripts are **the family's**, by key, beside its automations — written
once, used by several, in the configuration file as
`scripts: { tidy-up: { source: | … } }` (a new version of the file).

### 3.2 The script, as written

```ts
import { home, run, log, sleep } from 'kraftverk';

/** Turns off every lamp left on in an empty room, and says which. */
export default async function (inputs: { after: Duration }) {
  const off: string[] = [];
  for (const room of home.rooms) {
    if (room.occupied) continue;
    for (const lamp of room.devices.with('switch')) {
      if (lamp.switch.on) {
        await lamp.switch.set({ on: false }); // through the gateway, as the automation
        off.push(lamp.name);
      }
    }
  }
  log(`Turned off ${off.length ? off.join(', ') : 'nothing'}`);
  return { off };
}
```

### 3.3 The SDK: the whole of kraftverk, typed by the home

The owner's line — *anything a user can do* — has an answer the
architecture already gives: **`KraftverkApi`**, the one interface the app,
the server's HTTP API and the assistant all use
(`packages/api-contract/src/api.ts`). A script is one more caller of it.

Two layers, one module:

1. **`kraftverk/api`** — the whole `KraftverkApi`, as the app sees it:
   devices (add, rename, place, command, write a setting), automations
   (start, stop, change), modes, notifications, spaces and the map,
   labels, zones, the timeline, history. Its types are `api-contract`'s
   own declarations, emitted at build time — one source, never a second
   copy to keep in step.
2. **`kraftverk`** — the home as objects, generated from what it has,
   so the common things are one line and every name completes:
   - `home.devices['garage-plug']`, `home.rooms`, `home.modes.presence`,
     `home.people.anna.at('home')`, each device's parts, its readings by
     meaning **with their units** (`charger.power: Power<'W'>`), its
     commands by capability **with their arguments**
     (`lamp.switch.set({ on })`), its events, its settings;
   - this automation's roles, settings, what it remembers, and what the
     run knows (`run.trigger`, `run.who`, `run.event`);
   - `history(charger.power, '1 h')`, `sun`, `clock`, `sleep`, `log`,
     `remember`, `notify`, `setMode`, `start(automation, inputs)`.

   It is generated from the same data the checker already reads: the
   capability library (`packages/device-sdk/src/capabilities.ts`, whose
   commands, attributes and events are declarations), meanings and units,
   each device's description, the rule's roles, settings and memory, the
   family's people, places and modes. One generator, in
   `packages/automation`, run in the app as the editor opens and on the
   hub when it checks — `typesOf(home, automation)` → one `.d.ts`.

**Who a script acts as.** A new kind of caller,
`{ kind: 'automation', id, for }`: an automation acting for the person who
made it, with that person's role (an admin's script may do what an admin
may; a child's, what a child may). On the timeline it is the automation's.
Letting an automation act is the owner's yes to what its runs do; what
asks a yes of a person beyond that — removing a device, letting another
automation act — is refused, as it is to an assistant.

**What is never a script's**, whoever wrote it: signing in and accounts,
keys and recovery, secrets and exports with secrets, resetting the
database, the nodes, forgetting a person. The script surface is an explicit
list of `KraftverkApi`'s namespaces and methods, checked by the
architecture test so a new method is a decision, not an accident.

### 3.4 Running a script

- **One port**, in a shared package (a new `packages/script`, pure):
  `ScriptEngine` — "run this JavaScript with these limits and these host
  functions; give back its answer and its log". The platform supplies it,
  as it supplies storage and Bluetooth:
  - server and browser: QuickJS-NG as WebAssembly, in a worker it can be
    killed in;
  - phone: the native QuickJS module (an Expo module of kraftverk's own).
- **The bridge is narrow and asynchronous.** The guest sees the SDK; the
  SDK is a thin layer of JavaScript inside the sandbox over *one* host
  function, `call(method, args)`, that the hub answers through
  `hub.as(scriptCaller)` — the same code a person's request runs — and
  answers with JSON. Readings for `kraftverk`'s objects come as a snapshot
  at the start, refreshed after each `await`.
- **Limits**, each said in the run's log when reached: CPU time per slice
  and per run, memory, stack, calls to the API per run, commands per
  minute, the run's own deadline (a wait never outlives it), and the
  gateway's dwell and reserve as ever. A script function has a few
  milliseconds and no host calls but reads.
- **Watch mode and rehearsal**: a script step in watch mode runs with an
  API that records what it would do and refuses to do it — the run's log
  says "would turn off Hall lamp". A rehearsal on history gives it the
  readings of that time.

### 3.5 Types, and what is checked where

| Where | What |
| --- | --- |
| The editor (web worker; on the phone the DOM component's WebView) | Full type checking with TypeScript 6 against the generated `.d.ts`: completion, hover, every problem where it is |
| The hub, on save (any platform, Hermes too) | Types stripped with `sucrase`; the script's shape — its inputs, its answer, the SDK names it uses — checked against what the home has now |
| The run (any platform) | Every call across the boundary checked by the API as any caller's is; every command by its capability's declared arguments and by the gateway; the answer by the declared answer type |

A device removed after a script was written is then a problem on the
automation, as a removed device in a role is today.

### 3.6 The editor

- A `ScriptEditor` component — CodeMirror 6, the TypeScript language
  service in a worker, the generated types loaded — written once as an
  Expo DOM component, so the web and the phone show the same editor.
- The script's sentence and run log stay the automation's: the editor
  shows above it what the script reads and may do, from the same types.

## 4. Why this, and not something else

- **Not a whole automation as a script.** Triggers kept as data are what
  make kraftverk's automations explainable, rehearsable, restart-safe and
  editable as blocks; a script is the power inside them.
- **Not one engine per platform.** QuickJS-NG on all three means a script
  that passes on the server passes on the phone.
- **Not a separate scripting API.** `KraftverkApi` is already everything a
  person can do, with its permissions and timeline; a second API would
  drift.

## 5. Risks, and the spikes that settle them

| Risk | Settled by |
| --- | --- |
| Hermes may grow WebAssembly; the native module may then be unnecessary | A `typeof WebAssembly` check on the development build each Expo upgrade; the port lets the phone switch engines |
| The native QuickJS module is ours to own | Spike 1: an Expo module around QuickJS-NG with time, memory and stack limits and one async host function, on iOS and Android |
| A worker inside an Expo DOM component on a phone | Spike 2: CodeMirror plus the TypeScript 6 language service in a DOM component, completing against a generated `.d.ts` |
| TypeScript 6 is the last JavaScript compiler | It is only the editor's; the generated types are plain declarations any later checker reads |
| A QuickJS bug is a sandbox escape | One host function, every argument checked by the API, the gateway behind it; QuickJS kept current |
| A script with an admin's power does an admin's harm | Its caller's role, the explicit script surface, budgets, the timeline as the automation's, and acting only after the owner's yes |
| Reads go stale across `await` | The snapshot refreshed after each `await`; a reading's time is part of it |

## 6. An order of work

1. **Spikes**: the native QuickJS module; the editor in a DOM component.
2. **The engine**: `packages/script` with the `ScriptEngine` port; the
   WebAssembly engine on Bun and in the browser; script functions (pure),
   the safest first use.
3. **The SDK**: the type generator in `packages/automation`; the `kraftverk`
   module inside the sandbox; the script caller and its surface in the hub.
4. **The script step**: actions through `KraftverkApi`, waits, remember,
   watch mode and rehearsal; scripts in the configuration file.
5. **The editor** in the app, web and phone.
6. **The phone's engine**: the native module behind the same port.

## 7. Decisions for the owner

1. **Scripts as steps and functions inside automations** — triggers stay
   declarative (recommended) — or also automations written wholly as
   scripts?
2. **The script surface**: all of `KraftverkApi` but the list in §3.3
   (recommended), or narrower to begin with?
3. **Who a script acts as**: the person who made the automation, with their
   role (recommended), or always as an admin?
4. **Owning a native QuickJS module** for the phone (recommended), or
   waiting for Hermes' WebAssembly and offering scripts on the phone later?
5. **Scripts the family's, by key** — shared between automations
   (recommended) — or each automation's own?
