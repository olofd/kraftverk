# Kraftverk's automations against Home Assistant's

*Research, 2026-10-09. A rating and a gap analysis of kraftverk's automation
system against Home Assistant's (and, briefly, Node-RED, Homey Flow,
Hubitat Rule Machine and Google Home's script editor), and what to build to
surpass it. Kraftverk's side is read from `packages/automation/REFERENCE.md`
and the code; Home Assistant's from home-assistant.io up to 2026.10. Kept as
written: the language moves on; the reference says what is.*

## What kraftverk has today

- **Triggers (12):** `at` (a clock or the sun, with days), `every` (5 min to
  12 h), `becomes` (with `for`), a device's `event`, `arrives` / `leaves`,
  `first arrives` / `last leaves`, `empties` / `is occupied`, `mode becomes`
  / `mode changes` — each with its own `do`, an `id`, and `at most every`.
- **Steps (19):** commands and settings through the gateway, `set mode`,
  `notify`, `wait`, `wait until`, `wait for`, `make sure` (with retries),
  `if`, `watch`, `repeat` / `until`, `for each` (with `together`), `try`,
  `stop`, `answer`, `start` (and wait), `run script`, `remember`.
- **Expressions:** typed, with units; unknown is never true; history
  (`average`, `change`, `ago`, 1 min to 14 d), across a group, `distance`,
  who is at a place, `?:` / `??`, maths, package functions, and the pure
  functions of the family's scripts.
- **State:** `settings`, typed kept `memory`, typed `inputs` and `result`.
- **Run modes:** skip, restart, queue (up to 10). Bounds on everything: a
  wait at most 1 h, 10 tries, 100 rounds, 500 steps a run, nesting 4 deep,
  a chain of automations 4 deep.
- **Without acting:** watch mode, "what would it do now", rehearsal on the
  history.
- **Run log:** steps, readings and reachability in time; CSV; live, line by
  line, in the browser's console.
- **Scripts:** TypeScript in a QuickJS sandbox, a typed SDK naming the
  family's devices, people and homes, TypeScript's language service in the
  editor, a step run from the editor.

## Scores

| Area | kraftverk | Home Assistant | Why |
| --- | --- | --- | --- |
| Triggers | 5 | 10 | Twelve kinds; no webhook, MQTT topic, calendar, date, start-up, generic "changes from/to", tag or sentence trigger; nothing under 5 min. HA has some 250 ([triggers](https://www.home-assistant.io/triggers/)). |
| Conditions and expressions | 7 | 9 | Units, three-valued logic, history and groups are excellent; no text, dates or lists. Jinja does nearly anything, untyped ([template functions](https://www.home-assistant.io/template-functions/)). |
| Actions and control flow | 7 | 9 | `make sure`, `watch` and `try` are better primitives; no `parallel`, `while`, `choose`, or wait past an hour ([scripts](https://www.home-assistant.io/docs/scripts/)). |
| Variables and state | 4 | 9 | Only an automation's own memory: no run-local variables, shared values, counters, timers, schedules or derived sensors ([helpers](https://www.home-assistant.io/integrations/counter/)). |
| Reuse | 6 | 8 | Recipes from packages only, copied; typed inputs and results. HA: blueprints with selectors, re-import, scripts with fields ([blueprint schema](https://www.home-assistant.io/docs/blueprint/schema/)). |
| Typing and checking | 9 | 4 | Units, capabilities and events checked before it runs; scripts in TypeScript. Jinja fails as it runs; a script's required fields are not enforced ([script](https://www.home-assistant.io/integrations/script/)). |
| Debugging and simulation | 7 | 7 | A dry run (watch, rehearsal), no trace tree and no tests; HA has a rich trace graph, no dry run, five traces kept ([testing](https://www.home-assistant.io/docs/automation/testing/)). |
| Editor | 5 | 9 | Conditions said "in words" in the form, no drag, notes lost, no phone editor, YAML completion short of expressions. HA: drag, copy and paste, undo, notes, a target picker ([editor](https://www.home-assistant.io/docs/automation/editor/)). |
| Safety and verification | 10 | 3 | Every act through the gateway — dwell, confirmation, read-back — parts held between automations, a reserve kept, every wait bounded, nothing acts until armed. In HA an action is a service call. |
| Breadth of devices | 2 | 10 | Five device packages and nine integrations against thousands. |
| AI and voice | 4 | 7 | MCP tools (world, command, propose from a recipe, rehearse), no voice; HA has Assist, LLM agents, AI Task, MCP both ways ([AI Task](https://www.home-assistant.io/integrations/ai_task/)). |

**Overall: kraftverk 5.5 / 10** (the language and engine alone about 7.5;
breadth, shared state and the editor pull it down); **Home Assistant
8.5 / 10.**

## Where kraftverk is already better

1. **Checked before it runs:** units converted or refused, a command against
   the part's capability, an event against the device's description, each
   problem by its path. In HA a template's mistake shows as it runs.
2. **A real dry run:** watch mode, "what would it do now", rehearsing last
   week — none of it touches a device. HA has none.
3. **Unknown is a value:** an offline or stale reading is unknown, never
   false; a run that cannot decide does nothing and says why.
4. **Durable:** a `becomes … for` is kept in the database and resumes after a
   restart; HA's pending `for` and waits are lost on restart.
5. **Verified:** `make sure … within … tries` and the gateway's read-back
   check the device did it; parts are held between runs; "keep it so" puts
   them back.
6. **History in expressions:** `average(station.charge, 1 h)` inline; HA
   needs a helper per value.
7. **Typed functions:** inputs, results and answers, with ranges and units,
   enforced as it runs.
8. **Typed scripting of its own:** TypeScript in a sandbox, types from the
   home, acting as the automation's person through the same gate; HA's code
   ways (pyscript, AppDaemon) are third-party.
9. **People as a model:** `first arrives` / `last leaves` of a group, rooms
   occupied by evidence, presence that respects what each shares.
10. **Every rule reads as a sentence**, and the reference is made from the
    registry, every example tested.

## The biggest gaps, by what they cost a power user

1. **Devices and services:** no language makes up for five device types.
2. **Triggers:** webhook, raw MQTT, calendar, dates and months, start-up,
   "changes from/to", a time taken from a reading, tags and buttons, a
   sentence heard.
3. **Shared state:** no home values, counters, timers, schedules, toggles,
   or derived values other automations and screens read.
4. **Targets that follow the home:** HA targets "every light in the living
   room" by area, floor or label, current as devices change; kraftverk's
   groups are fixed lists.
5. **Control flow's ceilings:** an hour's wait at most; no `parallel`,
   `while`, `choose`, `let`, nor what a `wait for` heard; no lists, text or
   dates in expressions; no parallel run mode.
6. **Traces and tests:** no trace tree of every value read; the `tests:`
   section is planned, not built.
7. **The editor:** completion inside expressions, an expression block in
   the form, drag, copy and paste, notes that last, a phone editor.
8. **Sharing recipes:** HA blueprints import from a link, and again.
9. **Scenes:** nothing like snapshot and restore.
10. **Voice and models in automations:** no heard-sentence trigger, no "ask
    a model" step.

## What to build to surpass it

1. **A family of triggers, all typed:** `changes:` with `from` / `to`;
   `webhook:` declaring its payload as `inputs` are declared, read as
   `run.event.*`; `mqtt:` as an integration's event with a schema; hub
   start; dates and months; `at: role.meaning`; `every` from 1 min — each
   checked, each said.
2. **Typed home values:** a home's `values:` — toggles, numbers with unit
   and range, choices, counters, timers with a deadline, weekly schedules —
   read as `home.value.x`, a trigger, set by steps and people, on the
   timeline; derived values as expressions, kept in the history so lookback
   works on them.
3. **Roles that follow the home:** `lights: { every: switch, in: livingRoom }`
   (or a label, a floor), resolved as a run starts, checked by capability,
   said "every light in the living room".
4. **Control flow, bounds kept:** `let`, `choose`, `while`, `parallel`;
   `wait for` gives what it heard; waits of days made durable — a run's
   place kept across restarts; lists, text and dates in expressions.
5. **Tests and traces:** a `tests:` section on a virtual clock against
   simulated devices, in CI and behind a Test button; a trace tree drawn as
   the editor is, every value read; rehearsal that knows history, the sun,
   groups and script steps; watch mode that runs scripts against a recording
   gateway.
6. **A language service** shared by the form, the YAML editor and
   assistants: completion inside expressions, hover from the reference,
   problems at their line; then an expression block in the form, drag,
   copy and paste, notes, the phone's sentence editor.
7. **Breadth through bridges:** an integration that brings Home Assistant's
   (or MQTT's) entities in as parts with capabilities, commands back through
   the gateway — every HA device then typed vocabulary for kraftverk's rules.
8. **Shareable recipes:** one of yours published with its roles open;
   imported from a link; an upstream change shown as the rule's sentences
   that changed, taken only with a yes.
9. **Models and voice:** an MCP `draft` that writes rules with the checker as
   its critic and comes back rehearsed, watching, as a sentence to approve;
   a `heard:` trigger; an "ask a model" function that answers and never
   acts.
10. **Scenes and run modes:** `remember state of: group` and `restore`,
    through the gateway and verified; a parallel run mode and a run's total
    time; scripts on the phone.

The first five close the power user's gap; the next four turn kraftverk's
lead in checking, dry runs and safety into a lead in experience.
