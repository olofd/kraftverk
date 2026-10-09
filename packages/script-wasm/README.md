# @kraftverk/script-wasm

## What it is

A script sandbox over QuickJS-NG compiled to WebAssembly
([docs/PLAN-SCRIPTS.md](../../docs/PLAN-SCRIPTS.md) §8.2): the
`ScriptEngine` of `@kraftverk/script`, for the places that have
WebAssembly. That means a server on Bun, and the hub in a browser's worker.

## What it does — and does not

- **Does:**
  - `wasmScriptEngine(wasm)` compiles the engine once per place, from the
    `.wasm`'s bytes (a server reads them from disk) or its URL (a browser's
    worker serves it beside itself).
  - Each sandbox is a QuickJS runtime and context of its own: its stack
    limited, and an interrupt handler stopping a slice at its deadline.
  - The host's functions are lent as globals of one text argument. Those
    that answer later are promises inside, and each answer that comes is
    one more slice.
  - It passes the contract every engine keeps
    (`@kraftverk/script/conformance`), in `bun test`.
  - **Memory, held twice over.** QuickJS built for WebAssembly cannot count
    what it holds (there is no `malloc_usable_size` there), so a runtime's
    own limit stops only one allocation larger than it. So:
    - the engine's whole memory is made here, with a maximum (320 MB unless
      the place says less), and an allocation past it fails inside as "out
      of memory";
    - a sandbox is charged with whatever the engine's memory grows by while
      it runs, and stopped when that passes its own limit.

    What another sandbox let go of is used again before the memory grows,
    so a sandbox may also hold what is free. The engine's maximum bounds
    them all, and the memory never shrinks.
- **Does not:** find its `.wasm` (the place says where), run on a phone
  (Hermes has no usable WebAssembly; the phone gets a module of its own),
  or know anything of automations or the home.

## Where it fits

A shared package that imports only `@kraftverk/script`. Two places use it:
- the server's `platform/script.ts`, which hands the engine to the hub it
  builds;
- the browser's home worker (`client/src/platform/home/worker.ts`), with
  `quickjs.wasm` copied beside it by `client/scripts/build-home-worker.mjs`.

The versions are pinned together: `quickjs-emscripten-core` and
`@jitl/quickjs-ng-wasmfile-release-sync` 0.32.0, which carry QuickJS-NG
0.12.1. The phone's module must vendor that same QuickJS-NG.

## Why a package of its own

Because it is one place's choice of engine, not the port. The phone
implements the same port without WebAssembly, and nothing above the port
learns which engine it was given.
