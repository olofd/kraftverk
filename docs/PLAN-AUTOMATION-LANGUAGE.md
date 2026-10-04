# Plan: the automation language, next level — one registry, a typed language, bounded-complete power, an editor that is a joy

## Context

The owner wants kraftverk's automation language to become the best way to program
devices: very expressive, chaining anything together, as close to Turing-complete
as safety allows, schema-oriented and data-driven, and better than Home Assistant
and every other competitor. The first step (trigger ids, `run.trigger`, one
automation per charge window, the home Clock, the 12-second end-to-end cycle) showed
both the strength of the design and its ceiling.

What the survey of the code found (3 explorations, 2026-10-04):
- **Nothing is data-driven.** 11 expression kinds, 4 triggers, 8 steps, but ~36
  hand-written dispatch sites across ~20 files (checker, evaluator, inliner, words,
  reads, YAML reader *and* writer, JSON Schema, editor, engine, rehearsal). Several
  silently treat an unknown kind as the last one they know (`stepKind`, `#walk`,
  `describe`, `ruleToConfig`). The JSON Schema is hand-written beside the YAML
  reader and already drifts (params, `set`, durations).
- **The language is small.** No variables or memory, no loops, no lists, no
  strings, math is `+ - min max`, durations are untyped numbers (minutes in one
  place, seconds in another), event payloads are dropped, no history/aggregates,
  no sun/dates, `start` has no arguments or result, errors only via `otherwise`.
- **The engine is sound but static.** A bounded async tree-walker; one run per
  automation (overlaps dropped); all bounds static (`SEQUENCE_LIMITS`); watch mode
  and rehearsal can't simulate control flow; trigger state keyed by position.
- **The UX leaks.** Copied recipes lose their settings (values inlined into several
  places); holds shown as `0.5`; no hours; anything not drawable becomes "said in
  words — replace whole"; problems not placed on their step or YAML line; no
  completion inside expressions or for roles/meanings/commands in YAML; the served
  schema strips devices; Form↔YAML switch drops comments; sentences like "Not now:
  it is not so that one of its triggers started it".

The owner's decisions: **familiar typed expression syntax of our own**,
**bounded-complete** power (variables, kept state, loops, functions — under
budgets, every run terminates and is explained), **a sandboxed opt-in script
step**, and **foundation first**.

## Competitive position

| | What they do well | Where they fall short | What we do better |
|---|---|---|---|
| **Home Assistant** (2026.10) | Huge vocabulary; purpose-specific triggers ("battery became low"); `choose`/`repeat`/`parallel`/variables/`wait_for_trigger`; run modes; blueprints with typed inputs; traces; "Triggered by" without ids; a doc page per building block | Jinja templates are untyped strings that fail at run time; no units; no static check; state needs global helpers; no dry-run, no rehearsal, no tests; YAML verbose; verification of physical effect absent | Typed, unit-checked expressions checked *before* running; plain-language sentence of every rule; watch mode + rehearsal on history; gateway verifies the physical effect; one model with round-trip text; automations you can **test** on a simulated clock |
| **Node-RED** | Truly Turing-complete (JS function nodes); visual flows | Untyped, hard to read, diff and explain; no safety model | Same power where needed (script step) inside a typed, explained, gateway-safe language |
| **Homey Flow / Advanced Flow** | Friendly When/And/Then cards; logic variables; HomeyScript | Math and temp variables need workarounds/3rd-party apps; scripts can't return into flows | Variables, math, results and functions first-class; script results typed and usable |
| **Hubitat Rule Machine** | Powerful local rules, variables, waits | Notoriously hard UX | The power, with an editor that reads as sentences |
| **Google Home script editor** | YAML with autocomplete and validation; `suppressFor` | ~100 building blocks; no variables/loops | Autocomplete driven by *your* devices' meanings and commands, plus full language power |
| **openHAB / SmartThings / Apple Home** | Rule DSL + Blockly / typed Rules API / simplicity | Fragmented languages; limited logic | One language, two faces (blocks and text), one checker |

Where we must at least match HA: run modes, `parallel`, `repeat`/`for each`,
variables, wait-for-event, triggered-by without hand-made ids, per-block docs,
traces, step notes, rows that show their details. Where we lead: types+units,
static checking, explanation, simulation/tests, verification, safety budgets.

## Principles (what every change is held to)

1. **One description per construct** generates everything: checker, evaluator,
   words, YAML in and out, JSON Schema, editor block, reference page. A new
   construct is one entry; the compiler refuses a missing piece.
2. **Typed before it runs.** Every expression has a static type (with units);
   every problem is found while typing, placed on its field and line.
3. **Bounded-complete.** Anything expressible; every run terminates within
   declared budgets (steps, iterations, time), checked statically where possible,
   enforced at run time always.
4. **Explained.** Every construct says itself in a sentence; every run shows each
   value it read and decided on.
5. **Safe.** Every physical act through the gateway; scripts can't bypass it.
6. **Testable.** Any automation can be run on a simulated clock against simulated
   devices — in CI and in the app.

## Phase A — the foundation: a construct registry (packages/automation)

- `packages/automation/src/kinds/` — one file per construct, each a typed
  definition: `{ category: 'expr'|'step'|'trigger', key, fields: FieldSpec[],
  type(check ctx) , words, text: { verb, keys }, editor: { label, icon, help,
  group }, docs: { summary, examples } }`. `FieldSpec` is a small typed vocabulary
  (`expr<T>`, `duration`, `role`, `steps`, `enum`, `id`, `text`) shared by the
  checker, the YAML codec, the schema generator and the form.
- `Record<Kind, Definition>` tables make every category exhaustive at compile
  time; `kindOf()` throws on an unknown kind (no more silent fall-through).
- Generated from the registry: the YAML reader/writer (`text/rules.ts` becomes a
  generic codec), the JSON Schema (`home-file/src/schema.ts` hand-written parts
  removed), the editor's block forms, and `packages/automation/REFERENCE.md` +
  the in-app reference (one page per construct, with examples — matching HA's
  per-block docs, generated rather than written twice).
- Engine side: `automation-engine` registers one executor per step kind in a
  `Record<StepKind, Executor>`; `#walk`, `#wouldDo`, `#allowance`, rehearsal and
  `ruleUses` read the registry instead of `'x' in step` chains.
- Debts paid on the way:
  - Durations become typed values in seconds everywhere (`heldFor`, `every` in
    seconds with unit `s`; YAML still `for: 2 min`); one duration printer.
  - Structured problems `{ path, code, message, args }` replace regex-parsed
    strings (`check.ts:399-433`, `contribution.ts:53`).
  - Trigger state keyed by trigger id (ids generated and hidden when not written —
    HA 2026.10's "Triggered by", done right).
  - Constants instead of literals: `COMPARE_OPS`, `SEQUENCE_LIMITS` in the engine,
    one `CLOCK_TIME` and `TRIGGER_ID` pattern.
- `evaluate`/`evaluateNow` collapse into one evaluator with an `allowAsync` flag;
  `RuleScope` becomes an **environment** (`Env`: settings, roles, run facts,
  variables, event, home) so new namespaces are entries, not interface changes.

## Phase B — the expression language v2 (typed, familiar, ours)

- **Types:** number⟨unit⟩, boolean, string, enum, duration, time-of-day,
  datetime, list⟨T⟩, record, and `unknown`. Units as dimensions
  (power·time = energy, energy/time = power, %), conversions in the checker and
  evaluator (not only the text reader).
- **Syntax** (CEL/JS-familiar): `+ - * / %`, unary `-`, comparisons, `and or not`,
  `a ? b : c`, `x ?? fallback` (for unknown), member access `.`, index `[ ]`,
  list literals `[a, b]`, `in`, string literals and `+`, durations `2 min`,
  `1 h 30 min`, times `07:00`, dates.
- **Namespaces:** roles as today (`station.battery.soc`), `setting.x` (replaces
  `$x`), `var.x`, `run.trigger`, `run.event.<field>` (event payload — already on
  the bus, `holder/src/bus.ts:14`), `run.args.x`, `home.location`, `now`.
- **Functions — one registry for built-ins and packages** (role-free allowed):
  `round floor ceil abs clamp min max sum avg len contains lower upper format`,
  `now() today() weekday() duration() time()`, `sunrise() sunset()` (home
  location), history `avg(station.battery.soc, over: 1 h)`, `change(...)`,
  `value(..., ago: 10 min)` through a new history port on the engine
  (`HistoryStore` already has samples and hourly aggregates).
- **Lists:** `all(p in chargers: p.power.draw > 10 W)`, `count`, `map`, `filter`
  over role groups.
- Unknown stays three-valued (Kleene); `??` and `known(x)` handle it explicitly.

## Phase C — the automation language v2 (bounded-complete)

- **Variables:** `let` (run-local) and declared, typed `variables:` kept per
  automation (new `automation_var` table) — counters, last-seen, last value.
- **Settings kept:** automations keep their `settings` (the recipe's params) with
  titles, units and ranges; levels written once (fixes copied recipes; the hub's
  ban on params goes).
- **Control flow:** `repeat n`, `while`/`until … at most N times`,
  `for each p in group`, `parallel`, `try … if it fails`, `stop with outcome`,
  `wait for event (… within)`.
- **Role groups:** a role filled by several parts (`chargers: [plug1, plug2]`).
- **Functions:** an automation declares typed `inputs:` and a `result:`; `call`
  runs it with arguments and gets its result (recursion by the existing chain
  limit). Recipes become functions with defaults.
- **Triggers:** `changes` (any change), sun events with offsets, dates,
  `event` with a data filter, per-trigger `at most every …` (throttle, à la
  Google's `suppressFor`).
- **Run modes:** on overlap `skip | restart | queue (n) | parallel (n)`.
- **Script step (opt-in, sandboxed):** `script:` with typed `inputs`/`outputs`;
  runs in a `ScriptSandbox` port (QuickJS in WebAssembly on the server; not
  offered where no sandbox exists); its API reads values and *requests* commands
  that the engine sends through the gateway; CPU, memory and time limits; enabled
  per home; marked "advanced" and explained by its declared inputs/outputs.
- **Budgets:** per run steps, evaluations, iterations, variable size, wall-clock;
  the gateway allowance becomes a run budget the gateway still caps; loop
  iterations compacted in the run log.
- **Notifications** are a capability (`notify.send`) of a service package (an
  ntfy/push type), not a new step — the vocabulary stays data.

## Phase D — UX, YAML and the experience

- **Language service** in `packages/automation` (shared by app, CLI, assistant):
  parse with ranges, diagnostics, completion (roles, meanings per role, commands
  and args per capability, events, functions, trigger ids, variables, settings),
  hover with the reference, formatting.
- **YAML editor:** schema generated from the registry *and* the home's
  vocabulary, schema lint on, completion inside expression strings; the served
  `/config/schema.json` includes the vocabulary so VS Code completes too.
- **Form editor** generated from the registry's field specs: every construct
  drawable (an expression block with inline text mode replaces "said in words");
  insert anywhere, drag, duplicate, collapse; **notes on every step** (comments
  survive Form↔YAML because they are data); a Settings group with sliders; rows
  that show their details; problems on the field and the YAML line.
- **Words:** templates from the registry; reasons per construct ("Not now: the
  charge is between its levels"); durations always human ("2 min", "1 h 30 min").
- **Traces:** the run page draws the tree like the editor with every value read
  and every decision, variables over time, and replay.
- **Test it:** a `tests:` section on an automation (given readings/events over
  time → expect commands/outcomes), run on the virtual clock against simulated
  devices — in the app ("Test" button) and in CI. A first for home automation.
- **Mobile:** the sentence-and-sheet editor (`docs/AUTOMATIONS-UX.md` U3).

## Order of work (each step green and pushed)

1. A1 registry skeleton + exhaustive kinds; move one category (triggers) onto it
   end to end (checker, words, YAML codec, schema, editor, engine). *(Done
   2026-10-04.)*
2. A2 steps and expressions onto it; delete the hand-written schema and verb
   tables; durations in seconds; trigger state by id. *(Done 2026-10-04, with
   the rule's shape in the database's fingerprint and one evaluator.
   Structured problems moved to D2, where the editor places them.)*
3. B1 types, units as dimensions, the new syntax and operators; function registry
   with built-ins; `setting.` / `run.` / `var.` namespaces.
4. C1 settings kept on automations; variables and kept state; event payload.
5. C2 loops, `parallel`, `try`, `wait for event`, role groups, budgets, run modes.
6. C3 functions with inputs/results; history functions; sun/dates; throttle.
7. C4 script step behind the `ScriptSandbox` port.
8. D1 language service, YAML completion/lint, generated reference.
9. D2 generated form editor, notes, inline problems, words templates;
   structured problems `{ path, message }` with each data path mapped to its
   word in the file through the registry, so a problem sits on its field and
   its YAML line.
10. D3 traces, automation tests on the virtual clock, mobile sheet editor.

## Critical files

- Language: `packages/automation/src/{rule,check,evaluate,describe,reads,edit,draft,recipes,functions,contribution}.ts`, `text/{expr,rules}.ts`, new `kinds/`, `REFERENCE.md`, `README.md`.
- Engine: `packages/automation-engine/src/{runs,triggers,context,rehearse,listen,model,storage}.ts`.
- Store: `packages/store/src/{schema,automations}.ts` (automation_var, trigger state by id, run results).
- Schema/config: `packages/home-file/src/{schema,vocabulary,check}.ts` (+ a migration and kept fixture for the configuration document's version).
- Clock: `packages/device-sdk/src/clock.ts` (add a manual `virtualClock` with `advance()`).
- App: `client/src/features/automations/editor/*`, `client/src/components/YamlEditor.web.tsx`, `client/src/features/config/useAutomationYaml.ts`, run log pages.
- Server: `server/src/routes/configuration.ts` (schema with vocabulary); a QuickJS sandbox port implementation.
- Docs: `docs/AUTOMATIONS.md`, `docs/SEQUENCES.md`, `docs/AUTOMATION-EDITOR.md`, `docs/AUTOMATIONS-UX.md`, `docs/CONFIG.md`.

## Verification

- **Registry completeness test:** every kind has check/words/text/schema/editor/
  docs/executor; adding a kind without one fails to compile or fails the test.
- **Round-trip:** every recipe, every test rule and fuzzed rules: data → YAML →
  data and data → words, for every construct.
- **Schema parity:** the generated JSON Schema accepts every valid YAML fixture
  and rejects each invalid one with the same path the reader reports (ajv).
- **Language:** typing and units (dimension algebra), unknown propagation,
  every operator and function, error ranges.
- **Engine:** each control-flow kind on a virtual clock (deterministic
  `advance()`), budgets exhausted cleanly, run modes, parallel, try, kept
  variables across restarts, call with arguments and results.
- **End to end:** the fast-clock server runs scenario automations (keep-between,
  a counter with kept state, a for-each over chargers, a script step) in seconds;
  layout checks at 320/375 px for every new block.
- **Every step:** `npm run typecheck`, `npm test`, `npm run check:architecture`,
  `npm run test:e2e` green before the push.
