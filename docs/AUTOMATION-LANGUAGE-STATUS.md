# The automation language: what is done, and what is left

Where the automation language stands, measured against its plan,
[PLAN-AUTOMATION-LANGUAGE.md](PLAN-AUTOMATION-LANGUAGE.md) (phases A–D),
as of 2026-10-06. The work is paused here at a good point: every step below
"done" is deployed, its checks green, and documented. What is left is
listed in the order it is worth doing, each item small enough to be one
green step.

How the language works is in [packages/automation/README.md](../packages/automation/README.md);
every construct, with tested examples, is in
[packages/automation/REFERENCE.md](../packages/automation/REFERENCE.md)
(generated: `npm run gen:reference`); the file form is in
[CONFIG.md](CONFIG.md).

## Done

**Phase A — one registry.** Every trigger, step, kind of expression,
function, way of looking back, way of taking a group together, and part of
an automation is described once (`packages/automation/src/kinds`). The
checker, the file's reader and writer, the JSON Schema, the words, the
editor's generic fields, the database's fingerprint and the reference are
made from it; a construct with a piece missing does not compile, and every
example in the reference is read and checked by the tests.

**Phase B — typed expressions.** Units as an enum with dimensions
(`packages/device-sdk/src/units.ts`), converted as they meet, products and
quotients making their unit; `* /`, `?:`, `??`, `in [ ]`, `-x`; the
language's own functions; settings as `setting.x`; run facts as
`run.trigger` and `run.event.field`, each in the unit its device declares.

**Phase C — bounded-complete.**

| Construct | Written |
|---|---|
| Settings kept on an automation | `settings:`, read as `setting.low` |
| Kept memory | `memory:`, `memory.count`, a `remember` step |
| Per-trigger steps | `do:` under a trigger |
| Loops | `repeat: 5`, `until:`, `do:` |
| Failure handling | `try:`, `if it fails:`; `stop:` and `failed: true` |
| Waiting for a device | `wait for: mains.restored`, `from:`, `at most:` |
| Groups of parts | `uses: chargers: [a, b]`; `for each: charger`, `in: chargers`, `together: true` |
| Conditions over a group | `any(c in chargers: c.power > 10 W)`, `all`, `count`, `sum`, `average`, `lowest`, `highest` |
| Looking back | `average(station.charge, 1 h)`, `lowest`, `highest`, `change`, `ago` |
| The sun | `at: 30 min before sunset`, `time between sunset and sunrise` — the home's location in App settings |
| Overlapping starts | `while running: skip`, `restart` or `queue` |
| Throttling | `at most every: 10 min` on any trigger |
| Functions | `inputs:` read as `given.level`, `result:`, an `answer` step; `start:` with `with:` and `remember as:` |
| Budgets | at most 100 rounds a repeat, 500 steps a run, a wait an hour, a chain four deep |

Each is checked before it runs, said in words, written and read back in a
file, run by the engine, and shown in the editor at least in words.

## Left to do

### 1. Show in the app what the language now keeps

Small, and what a person notices first.

- **What it answered.** A run keeps `answered`; the run page and the run log do not show it yet.
- **What it remembers.** No API reads an automation's memory, or sets it back to its starting values; its page should list each value, with a way to reset it.
- **Inputs when played.** A person playing an automation, or an assistant, cannot give it inputs: `start` takes only the defaults. The play button could open a small form made from `inputs`.
- **Declaring settings, memory, inputs and result in the form.** Today they are written in YAML; the editor only edits their values.

### 2. Phase C, what was planned and not built

- **A general `parallel` step.** Steps side by side. `for each … together: true` covers the case that matters most; a plain parallel step needs lanes in the editor's path model (`ListPath`).
- **Run-local variables.** A value worked out once in a run and read by later steps. `memory` covers what lasts across runs; a `let` within a run is cleaner for intermediate values.
- **Parallel runs of one automation.** `while running` has `skip`, `restart` and `queue`; running several at once needs the one-run-per-automation index and the live run map keyed by run.
- **A wall-clock budget per run.** Today each wait has its limit, and a run its step count; a total time limit would make the bound explicit.
- **Dates and the calendar.** A month, a day of the year, a date range; dawn and dusk beside sunrise and sunset.
- **What a waited-for event carried.** `wait for` does not hand later steps the event's data, as `run.event` does for the event that started the run.
- **Groups beyond conditions and loops.** A group made in the editor only from a `for each` block; looking back across a group (the average of each part's history) is not composed; a package's function cannot be asked of each part.

### 3. Phase C4 — the script step

An opt-in `script:` step with typed inputs and outputs, run in a sandbox
(QuickJS in WebAssembly, behind a `ScriptSandbox` port), whose commands are
requests the engine sends through the gateway, under CPU, memory and time
limits, enabled per home. Not started.

### 4. Phase D1 — a language service

One service in `packages/automation`, used by the app, the YAML editor and
an assistant: completion inside expressions (roles, each role's meanings,
commands and their arguments, settings, memory, inputs, functions), hover
with the reference's text, problems placed on their YAML line and column,
and formatting. The served `/api/config/schema.json` already names the
home's devices; completing inside expression strings is the gap.

### 5. Phase D2 — the editor as the language

- **Every construct drawable.** Conditions using the newer kinds — looking back, the sun, across a group, `given.`, `memory.` — are shown "said in words", with a fixed value offered in their place; an expression block with an inline text mode would replace that.
- **Notes on steps** that survive the round trip between form and YAML (comments are lost today).
- **Problems on their field**, not only in the group's list.
- **Rows that show their details**, drag to reorder, duplicate, collapse.

### 6. Phase D3 — traces, tests and the phone

- **Traces.** The run page drawing the tree as the editor does, with every value read and every decision.
- **Automation tests.** A `tests:` section — given readings and events over time, expect commands and outcomes — run on a virtual clock against simulated devices, in CI and from a Test button. The engine's tests in `packages/hub/test/engine.test.ts` show the shape.
- **The phone editor.** The sentence-and-sheet editor of [AUTOMATIONS-UX.md](AUTOMATIONS-UX.md).

### 7. Rehearsal

Rehearsing a rule on history (`packages/automation-engine/src/rehearse.ts`)
does not yet know looking back, the sun, or groups: a rule using them is
unknown there. History is already at hand for it.

## Worth knowing before picking it up

- **A change to how a rule is kept resets the database.** The fingerprint (`ruleShape`, `packages/automation/src/kinds/shape.ts`) carries every kind, field and rule part, so each such change sets the database aside on deploy, and the home comes back from the configuration kept beside it — its devices, automations, values and location. The accounts are carried from the database set aside (sign in again). What automations remember, and their runs, start afresh too.
- **The rule's parts are listed in a few places by hand.** `RULE_PARTS` (`kinds/shape.ts`) and `RULE_PART_DOCS` (`kinds/parts.ts`) are held complete by the compiler; `inlineParams` (`evaluate.ts`), `ruleFromConfig`/`ruleToConfig` (`text/rules.ts`) and the file's keys (`packages/home-file/src/document.ts`) must be kept in step when a part is added.
- **Run the tests with the pinned Bun** (`node scripts/run-bun.mjs test …`, or `npm test`): an older Bun on the path hangs one engine test.
