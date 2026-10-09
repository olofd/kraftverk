# @kraftverk/script

## What it is

Scripts in TypeScript, for automations ([docs/PLAN-SCRIPTS.md](../../docs/PLAN-SCRIPTS.md)):
a script compiled to the JavaScript a sandbox runs, what it declares read
from it, the guest SDK it imports as `kraftverk`, and the port every
sandbox is reached through. No engine of its own: the place gives one.

## What it does — and does not

- **Does:**
  - **Compile.** `compileScript` strips a script's types and turns its
    imports into calls to `require`, with sucrase, which is plain
    JavaScript and so runs wherever a hub does. Lines stay where they were
    written, so a fault names the line a person wrote.
  - **Read.** `readScript` reads a script: its size, whether it compiles,
    what it imports (`kraftverk` and `kraftverk/api`, and nothing else), and its shape. The shape
    — its steps with their inputs, answer and memory, and its functions
    with their arguments and result — comes back in the language's own
    fields (`ScriptShape`, `@kraftverk/automation`). It is read from the
    exported functions' signatures as written (`signature.ts`, with
    sucrase's parser): an `async function` a step, a plain `function` a
    function, each parameter in the language's types, its doc comment its
    title and limits. Then the top level runs once, in a sandbox that
    reaches nothing, so what fails as it loads is said at once.
  - **Names.** `names.ts` is what a script calls a person, a home, a
    room or a device — `family.maria`, `devices.garagePlug` — one rule
    for the types and the sandbox.
  - **The guest SDK.** It lives in `src/guest/`, bundled into one string,
    `src/generated/guest.ts`, by `npm run gen:script-guest`; the
    architecture check keeps it current. It holds the family's world as
    objects (`devices`, `family`, `home`, `homes` — a home's variables as
    `home.vars`, set by `home.setVariable` and `home.count`), `log`,
    `sleep`, `notify` and `setMode`, the `require` a script is given, and
    the entries the host calls.
  - **The port.** `ScriptEngine` opens a `Sandbox`: one heap, run one
    slice at a time on the caller's thread. Text is all that crosses, both
    ways. A `ScriptFault` says why a script stopped: what it threw, its
    time, its memory, its stack, a stop, or its syntax.
  - **The types.** `typesOf(home)` writes the `kraftverk.d.ts` a script is
    checked against in the editor: the SDK's own declarations — the types
    a signature is written in, `Duration`, `Celsius`, `Kept<…>` — and the
    family's people, homes, rooms, modes, variables and devices by name, a device's
    readings typed, and each part's capabilities with their commands and
    arguments, one interface each.
  - **The contract.** `@kraftverk/script/conformance` is what every engine
    does alike: the WebAssembly engine runs it in `bun test`, and the
    phone's engine will run it on the phone.
- **Does not:**
  - check types: that is the editor's;
  - run a script for an automation, or reach the home: that is the hub's,
    with the script step;
  - hold an engine: QuickJS as WebAssembly is `@kraftverk/script-wasm`'s,
    and the phone's will be its own module.

## Where it fits

A shared package, pure, above the SDK and the language: it imports
`@kraftverk/device-sdk` and `@kraftverk/automation`. The hub uses it to
read and run scripts; an engine implements its port. The place joins the
two, giving the hub the engine it can run.

## Why a package of its own

Because a script is the same wherever it runs, on whichever engine. It is
compiled the same way, its shape is read the same way, and it is given the
same SDK, held by one contract. Kept apart from the engines, the phone's
module can implement the port without carrying WebAssembly. Kept apart
from the hub, the editor and the app can read a script's shape without
running a home.
