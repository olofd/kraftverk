# Plan: fixes, running and chaining, then the language for import and export

Written 2026-09-30, after the charging sequences were first set up on the
home server and after a review of the twelve commits from 5b4ff32 to
3d9b245. It collects everything found, what the owner decided, and the
order to do it in. Each phase keeps `npm run typecheck`, `npm test` and
`npm run check:architecture` green on every commit; the e2e suite runs at
the end of each phase.

## Decisions taken

- **Play always runs it.** Pressing play is a person asking, like flipping a
  switch: the run is real and goes through the gateway, whatever the mode.
  The mode — Off, Only watch, Act — governs only what an automation does on
  its own: its timers, its conditions, and nothing else. Off means off: no
  play, and no other automation can start it. Playing one that only watches
  asks for a confirmation first ("This switches … for real"), derived from
  the mode, not stored.
- **Chaining is a step.** Any automation can take the step "Start ‹another
  automation›", and may wait for it to finish. "If tomorrow looks sunny,
  start charging" is a forecast rule whose action is to start the
  sequence. Each automation keeps its own runs; a run started by another
  says which run started it.
- **Sequences get timers.** A sequence started when you ask can also be
  started at a time of day on chosen weekdays, set per automation.
- **Shortcuts on the first page.** An automation can be put on the home
  page, for the whole home, with a play (or stop) button and its state.
- **An automation editor, not a recipe picker** (the owner, 2026-09-30).
  - Today the app only lets you choose a ready-made recipe and set its
    sliders. The language underneath is general blocks, but you cannot add,
    remove, reorder or nest them.
  - Every automation owns its rule, built by its owner from blocks:
    - a block for any command a device's part offers;
    - a block for any setting it can write, such as the Zigbee plug's fast
      refresh after it has been reached;
    - pause, wait until, make sure (with its retry), if / otherwise, and
      watch;
    - start another automation;
    - conditions built from readings, comparisons, and / or / not.
  - Recipes become starting points: copied into a new automation, then
    edited like any other.
  - The server checks every save against the language's limits.
  - **This reshapes Phase 2**, and brings the write step forward from
    Phase 4. It is redesigned, and written here, once Phase 1 is done.

## Phase 0 — ship what is waiting

| What | State |
|---|---|
| The unhandled rejection that failed the unit job: a run kept after its automation was deleted (d51a22b) | pushed |
| Deleting an automation stops its run, whichever kind, and keeps none of it; `AutomationRun.id` null documented (49451c7) | committed, not pushed — pushing redeploys the home server; pushed when the owner is not testing |

## Phase 1 — bugs and polish (no schema change)

Small, each its own commit. Numbers are for reference in commits.

**Done, 2026-09-30.**

| Items | How it ended |
|---|---|
| 1–4, 7–17 | Fixed, each its own commit that names its item; checked in the browser where it shows there; typecheck, unit tests, the architecture check and the e2e suite green |
| 5, 6 | Left to the automation editor, which replaces the recipe editor they are about |
| 7 (one button) | "Try it" and "What would it do now?" become one with play (Phase 2) |
| 12 | Tested as far as it can be without the plug in hand; what is still to learn is in its README |

**Found on the way, and fixed too:**
- PUT was missing from the methods allowed to a browser elsewhere, so a
  picture or a policy value could not be set from the app in development.
- The mode switch (Off / Only watch / Act) could not be reached by keyboard.
- The picture control could not be pressed by keyboard.
- Uploaded readings from an app-held device never reached the live stream.

### Automations: engine and gateway

1. **The gateway forgets a run's switch counts when it ends.** `#runSwitches`
   (`packages/gateway/src/gateway.ts`) is keyed by run and never cleared.
   Add `Gateway.runEnded(runId)`, called by the engine as a run ends
   (`server/src/automations/engine.ts`, where it calls `endRun`); test that
   the map is empty after a run.
2. **An agent's start is an agent's.** A run started by an assistant uses the
   agent dwell, not a person's: carry who asked (`person` or `agent`) from
   `startAsked` into `CommandIntent.run`, and have the gateway pick the
   dwell by it. Write the rule into ARCHITECTURE.md §4.6 (today only
   `AGENT_RULES` says it). Test both dwells.

### Automations: the app

3. **One refresh per change.** `client/app/automations.tsx` polls every 15 s
   and also listens for `automation` messages. Poll only while the live
   stream is down (DevicesProvider knows), and refresh on the message
   otherwise.
4. **Words.**
   - The possessive mixes ’ and ' ("the charger’s plug's power"): `possessive()`
     in `packages/device-sdk/src/automation.ts` uses ’ everywhere.
   - "what powers the charger's power": a role label that is already a
     noun phrase for a device takes "the power of …" rather than a
     possessive; `describeExpr` chooses by whether the label reads as a
     thing ("the charger's plug") or a clause ("what powers the charger").
   - The sentence and the steps name a part two ways ("AFERIY P280's AC
     outlets" and "AFERIY P280 — AC outlets"): one form, the steps'.
   - A resolved choice reads as a rule, not a question: "If you chose
     “Switch it and its supply off again”" becomes the steps alone, under
     "If a step does not succeed, or you stop it"; the choice shows only in
     the editor.
   - The page header "What happens on its own" becomes "What runs on its
     own, and what you start".
5. **The editor's preview names what was picked.** Once a role is filled,
   "What it will do" uses the device's name, as the card does (the server
   already describes a bound rule; the editor asks for it with the roles
   chosen so far).
6. **One part cannot fill two roles.** The checker refuses a binding where
   two roles take the same part (`server/src/routes/automations.ts`, and the
   editor greys the part out in the second list).
7. **What it would do, said once and with what is already so.**
   - "You only asked what it would do" once, above the steps, not under each.
   - Each command step says "already so" when the part is already as it
     would set it (the engine has `#alreadySo`; the would-do path uses it).
   - "Try it" and "What would it do now?" become one: see Phase 2, where
     play takes the first place and "What would it do?" the second.
8. **Confirmations look as dangerous as they are.** Every yes button in
   `ConfirmHost` is `$danger`. `withConfirmation` takes a tone from the
   declared consequence (harmless, careful, dangerous); arming and "Do it"
   are careful, not dangerous.
9. **`PicturePicker` traps focus and gives it back**, as `ConfirmHost` does.

### Devices

10. **"Power" means one thing.** The Tuya socket (and the Zigbee plug that
    uses it) labels both the watts and the switch "Power". The switch
    becomes "Switch" (On/Off); history and readings list each once
    (`packages/devices/tuya-plug/src/socket-type.ts` and its profiles).
11. **A switch's warning follows the links.** "If it feeds a station, the
    station then runs from its battery" shows only when a link says this
    plug feeds a station; a plug the station feeds says "Switches off
    whatever is plugged into it". The device keeps its own consequence;
    the link part is added from the link graph.
12. **A Zigbee plug's remembered answer is not a current reading.** While the
    gateway says the plug is offline, the session stamps nothing from the
    gateway's memory as current (it is so for polls; make it so for pushes
    too, and test it).
13. **Fresh readings, one lease.** Several watchers asking the Tuya socket to
    report often share one lease: the latest `until` wins, and one timer
    runs. Test with two overlapping waits.
14. **The NIU package's dependencies run one way.** `src/type.ts` imports
    from `ui/words.ts`; the constants move into `src`, `ui` imports them.
    `check:architecture` gains the rule: a package's `src` never imports
    its `ui`.
15. **A parked scooter's readings keep the time it reported them.**
    `standsSince` stamps the poll time as `Reading.at`, which means "when
    the device said it". Keep the report time as `at`; say "answered at"
    through the session's health instead, and let the page say "as of
    14:02, NIU last answered 14:31".

### The app, all pages

16. **Fetch once.** `/devices` and `/devices/removed` are fetched twice back
    to back on every change, and `/found` is polled very often; while signed
    out, polling runs on and collects 401s (350 in one session). One fetch
    per change, `/found` only while the add screen is open, and nothing
    polled until signed in.

### Docs

17. **HANDOFF states no counts.** "Every check is green" is said by the
    checks; HANDOFF drops the test numbers it keeps getting wrong.

## Phase 2 — running and chaining (one schema change)

All the schema changes of this phase land in **one** commit, so the home
server's database is set aside once: its devices (four, the Zigbee plug's
key among them) and its automations are added again after the deploy.

### The data model

```sql
-- automation gains a column (in its one CREATE TABLE): on the home page,
-- and where; NULL, not on it. Unique among those that are.
home_place INTEGER CHECK (home_place IS NULL OR home_place >= 0)
CREATE UNIQUE INDEX automation_home ON automation (home_place) WHERE home_place IS NOT NULL;

-- A sequence's timers: a time of day on chosen weekdays (bit 0 = Monday).
CREATE TABLE automation_schedule (
  automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
  at            TEXT NOT NULL CHECK (at GLOB '[0-2][0-9]:[0-5][0-9]'),
  days          INTEGER NOT NULL CHECK (days BETWEEN 1 AND 127),
  PRIMARY KEY (automation_id, at)
);

-- A role is filled by a part of a device, or by another automation.
CREATE TABLE automation_role (
  automation_id TEXT NOT NULL REFERENCES automation (id) ON DELETE CASCADE,
  role          TEXT NOT NULL,
  device_id     TEXT REFERENCES device (id) ON DELETE CASCADE,
  part          TEXT,
  starts        TEXT REFERENCES automation (id) ON DELETE CASCADE,
  PRIMARY KEY (automation_id, role),
  CHECK ((device_id IS NOT NULL AND part IS NOT NULL AND starts IS NULL)
      OR (device_id IS NULL AND part IS NULL AND starts IS NOT NULL))
);

-- Which run started this one, when another automation did.
automation_run.started_by_run TEXT REFERENCES automation_run (id) ON DELETE SET NULL
```

The NULLs mean something: not on the home page; a role filled by an
automation, not a device; a run no other run started. An automation
deleted takes the roles that start it with it, and the automations that
used it say "a role has nothing to start", as they do for a deleted device.

### Play

- **API.** `POST /automations/:id/start` always runs it for real (409 when
  off, or already running). `POST /:id/check` stays "what would it do". The
  start route's check-when-observing branch goes.
- **Engine.** `startAsked` no longer turns into a check when the mode is
  observe; it refuses only when off. The mode is read by the triggers alone.
- **App.**
  - The card leads with a play button (▶ Start, or ■ Stop while it runs).
  - Played while only watching, it asks first: "This switches the AC
    outlets and the Smart plug for real. It still only watches on its own."
  - "What would it do?" is the second button.
  - `RunControl` loses "Try it".
- **Assistant.** The `start` tool follows the same rule, and says in its
  answer that it acted.

### Shortcuts on the first page

- **API.** `PATCH /automations/:id { homePlace }`, audited. `GET /automations`
  carries `homePlace`.
- **App.**
  - A "Put on the home page" switch on the card, and reordering in the
    home page's edit mode.
  - The home page gets a "Shortcuts" row above the devices. Each shortcut
    is a tile with the name, a play or stop button, the step it is in
    (counting down, as on the card) and the last outcome.
  - A live `automation` message refreshes the tile.

### Timers

- **Language.** Nothing new in a rule: a timer belongs to the automation,
  not its recipe. Only automations started when asked (`startsWhenAsked`)
  take timers; the others keep their recipe's triggers.
- **Engine.** Each tick checks the timers: due at its time on a chosen day,
  on the owner's clock, within the grace, and not already started since.
  This is the same rule as `#dueAt`, taken out of it and shared.
  - Only watching: the run is kept as "would-act".
  - Acting: it runs.
  - Off: nothing.
- **App.** A "When it starts on its own" section on the card: add a time,
  pick weekdays (Mon–Sun chips, "Every day", "Weekdays"), remove.
- **Rehearsal.** For a sequence with timers, it says what each timer would
  have done at its times, as far as history can tell (the first command
  step), and no further.

### Chaining: the start step

- **Language** (`packages/device-sdk/src/automation.ts`).
  - Step `{ start: { role, wait?: boolean } }`.
  - A role may need an automation that can be started:
    `{ automation: { startsWhenAsked: true } }`.
  - `describeSteps` reads "Start ‹name›", or "Start ‹name› and wait until it
    ends — at most …" when it waits.
  - A wait has its limit like every wait: `SEQUENCE_LIMITS.waitSeconds`, or
    a param.
  - `ruleUses` and `takesSteps` learn the step.
  - A `start` is allowed in `then` and in a `choose`, not in a retry, and
    in `otherwise` only without `wait`.
- **Checker at save.**
  - The started automation exists and is started when asked.
  - No cycle: the chain from this automation through its `starts` roles
    never comes back to it.
  - A chain is at most four deep.
- **Engine.**
  - The step calls `startAsked` with the run that started it. It is refused,
    with the reason as the step's detail, when the target is off, already
    running, or deeper than allowed.
  - With `wait`, the step lasts until the started run ends, and succeeds
    when that run acted.
  - Stopping the parent while it waits stops the child too.
  - The child's commands are asked by whoever asked the parent (a person's
    play gives the whole chain a person's dwell; a timer or a condition
    gives it the automation's).
  - Only watching, a parent says it would start the child and does not.
- **Recipes.** Open-Meteo ships "Start by the forecast": once a day at a
  time, if the day looks sunny (or cloudy, as chosen), start an automation.
  The forecast switch stays beside it.
- **App.**
  - The editor lists automations as the parts that can fill a start role.
  - The card's step reads "Start ‹name›" and links to it.
  - A started run says "Started by ‹parent name›" and links back to the
    run that started it.

### Tests and checks for Phase 2

- **Language.** The start step's checks (cycle, depth, allowed places) and
  its description.
- **Engine.**
  - Play in each mode.
  - Timers due and not due, in each mode.
  - A chain with and without `wait`.
  - A stop that stops the child.
  - A refused start.
  - A deleted child: the parent says so.
- **HTTP.** Start in observe acts; `homePlace` round-trips; schedules are
  validated.
- **E2E.** Play a sequence from its card and from the home page; the tile
  follows the run; a forecast automation starts the charging sequence and
  both runs show, linked.
- **Docs.** SEQUENCES.md (play, timers, start step), AUTOMATIONS.md (the
  mode governs its own triggers only), DATA-MODEL.md, API.md.
- **On the home server.** Re-add the devices, make "Start charging the
  scooter" and "Stop charging the scooter", put both on the home page,
  play them, then chain start charging behind "Start by the forecast".

## Phase 3 — decided on paper first

Two decisions shape every energy automation after this. Each gets a short
design note before any code.

1. **Automations that share a part.**
   - An import rule and an export rule both act on the station's charge.
     "Keep it so" on one undoes the other at every recheck, and only the
     gateway's dwell stands between them.
   - Proposed: a run holds the parts its roles name. The engine lets one
     run at a time act on a held part. A second waits or is refused, as
     its rule says. The card says "also acted on by ‹name›".
   - The note decides waiting versus refusing, priority, and how "keep it
     so" yields to a run that holds the part.
2. **A reserve the gateway keeps.**
   - A home policy value `reserveSoc`, beside `loadWatts`.
   - A declared consequence on turning a storage part's outputs on, or its
     discharge up, while `battery.soc` is below it: refused for
     automations, confirmed for people.
   - Without it, an export automation is a discharge automation.

## Phase 4 — the language, for import and export

In this order; each is small and pure in the SDK, then its engine and
screen part. Standard recipes stay free of product words.

1. **A write step.** `{ write: { role, means, value } }` for a writable
   setting.
   - The checker refuses a dangerous attribute; the role must be bound to
     a part that has it writable.
   - It goes through the gateway's write path, verified by reading back.
   - Needs standard meanings for the settings every station has: a charge
     ceiling, a reserve floor, a mains charging power. The P280 maps its
     registers to them in its package.
2. **Time of day in expressions.** `{ within: { from, to } }` is true between
   two clock times, across midnight, on the owner's clock. It is usable in
   `if`, `becomes` and waits.
3. **Arithmetic.** `add`, `subtract`, `min` and `max` over numbers, with
   units checked as compares check them.
4. **A price as readings.**
   - A price service reports the current hour's price and its rank among
     today's hours, as readings. "The cheapest four hours" is then
     `rank <= 4`, which `becomes`, holds, rechecks and rehearsal all
     understand.
   - Needs a money quantity and the meanings `price.now` and `price.rank`.
   - Open-Meteo is the model: readings beside its forecast query.
5. **Richer time triggers on recipes.** `at` takes weekdays (as the timers in
   Phase 2 do), an interval ("every 15 minutes"), and sunrise and sunset
   from the home's place. "When tomorrow's prices arrive" is a service
   event and already works.
6. **Smaller.**
   - A role filled by an ordered list of parts ("shed these loads in this
     order").
   - A step may keep a value it read, for a later step.
   - A long pause past an hour is still a `waitUntil` on what it waits for.
   - `wantFresh` for the P280, so a watch over its outlets sees fresh
     readings.

## Later, unchanged

- **HANDOFF's next steps.** J25, J35, J31, J40, the assistant's token, and
  Phases 6–9 follow the phases above.
- **The NIU family.** `defineNiuScooter` taking overrides waits for a third
  model.
