# Sequences: automations that take steps

**Status:** built (2026-09-30), in the order of "Building it" below; tried on
the owner's real chain last.
Extends [AUTOMATIONS.md](AUTOMATIONS.md): one language, one engine, one
gateway — an automation that takes steps is an automation, not a second kind
of thing. Since then ([AUTOMATION-EDITOR.md](AUTOMATION-EDITOR.md)) every
automation owns its rule and can be started by hand, so the `asked` trigger
is gone; and a step may change a setting, or start another automation.

## The challenge

A home where one battery charges another, through a chain of devices:

```
mains ─► smart plug ─► station (battery, inverter) ─► AC output ─► Zigbee plug ─► scooter charger ─► scooter
```

"Start charging the scooter" is not one command. It is:

1. Switch the station's **AC output** on — its inverter starts.
2. **Wait** until the Zigbee plug can be reached: it has no power until the
   inverter runs, and must rejoin its gateway first — up to a couple of
   minutes.
3. Switch the **Zigbee plug** on.
4. **Make sure** the charger charges: it should draw **over 50 W** within
   about 20 s. This charger sometimes stays in its idle (green) state when its
   power comes on; switching it off for a few seconds and on again wakes it.
   So: if it does not draw, switch the plug off, wait 5 s, switch it on, look
   again — **at most 3 times**.
5. If it never charges, **stop, and say so** — and switch off what it switched
   on, unless its owner chose to leave it.

A person can do this with a phone in their hand. An automation today cannot:

- It **reacts**, all at once. A run evaluates its condition and sends its
  commands in one go. There is no "wait until", no "make sure, or else", no
  "when I ask".
- The **gateway** gives an automation **10 minutes between switches** of one
  part — the right guard against rules that flap, and exactly what refuses the
  charger's off-and-on.
- **Readings are slow where speed is needed**: the plug's power is asked for
  every 15 s — too slow to judge "is it charging" within 20 s.
- **Reachability is not a value** a rule can read. And a Zigbee plug's
  gateway answers from its own memory while the plug has no power, so its
  readings look current when they are not.

## What it must be

- **First-class.** A sequence is an automation: built from blocks or copied
  from a recipe, bound to devices by roles, watched before it acts, let act on purpose, on the timeline,
  explained. The same language, checked by the same checker, read back in
  sentences, run by the same engine, through the same gateway.
- **No device in the platform.** The core names no plug, charger or station.
  The chain above is a *recipe* in the shared vocabulary — library
  capabilities (`switch`, `powerMeter`) and standard meanings — so any station
  with a switchable output and any plug that measures power fills it.
  Device-specific behaviour (how a Zigbee plug is polled, when its gateway's
  answers count) stays in the device's package.
- **Safe by construction.** Every step is data. A sequence can read, compare,
  wait, and ask the gateway for commands — nothing else. Every wait has a
  limit; every retry has a count; every switch goes through the gateway, which
  enforces its own floor on how fast and how often, whatever a rule asks.
- **Clear.** The owner sees the sequence as numbered steps in plain words; a
  run shows each step as it happens — done, waiting (and for how long),
  retried, failed — and says, in one line, how it ended.

## The language: steps

`then` was a list of actions. It becomes a list of **steps**, of which an
action — a command — is one. A rule whose steps are only commands runs as
before, at once.

```ts
type Step =
  | { command: Command }                                    // through the gateway, as today
  | { wait: { for: Expr } }                                 // a pause
  | { waitUntil: { condition: Expr; atMost: Expr } } // until true — or the run stops, not having succeeded
  | { ensure: {                                             // make sure something comes true
      condition: Expr;
      within: Expr;                                  //   each time, given this long
      tries: Expr;                                          //   and retried at most this often,
      retry: Step[];                                        //   each time by these steps
    } }
  | { choose: { if: Expr; then: Step[]; else?: Step[] } }   // one way or the other, as a condition is now
  | { watch: {                                              // watch a condition for a while:
      condition: Expr; for: Expr;
      then?: Step[];                                        //   if it stays true all that time
      else?: Step[];                                        //   the moment it is not, or cannot be told
    } }
  | { write: { role: string; value: Expr } & ({ key: string } | { means: string }) }   // a setting the part keeps, by key or meaning
  | { start: { role: string; andWait?: Expr } }         // another automation — waited for, at most so long
  | { waitFor: { role: string; event: string; atMost: Expr } }       // until the part says something happened
  | { repeat: { times: Expr; until?: Expr; steps: Step[] } }         // round after round — or until true, at most so many
  | { try: { steps: Step[]; recover?: Step[] } }                     // a step that does not succeed answered, and on
  | { stop: { why: string; failed?: boolean } }                      // the run ends here, saying why
  | { remember: { name: string; value: Expr } }                      // a value kept for later runs
  | { forEach: { as: string; in: string; together?: boolean; steps: Step[] } };   // each part of a group, in turn or at once

type Rule = {
  roles; params;
  when: Trigger[];
  if?: Expr;
  then: Step[];
  /** If a step does not succeed, or a person stops it: nothing here waits for what might not come. */
  otherwise?: Step[];
};
```

Six kinds of step, each general, none about charging: **do** (a command),
**pause**, **wait until**, **make sure** (with retries), **choose**, and
**watch** — and, added with the editor, **change a setting** and **start
another automation**; and, with the language's second phase
(docs/PLAN-AUTOMATION-LANGUAGE.md), **wait for an event**, **repeat**,
**try**, **stop**, **remember** and **for each**. Steps nest — a choice, a watch, a repeat, a for each
and a try hold steps — at most four deep, and a run takes at most 500 steps
(`SEQUENCE_LIMITS`), so whatever it repeats, it ends.
A choice its settings alone decide — "if you chose to switch them off
again" — is no step a person follows: it reads, is tried and runs as the
steps it chose, in its place (`settledChoice`). Only a choice that turns on
what is read as it runs shows as "If …".
Where failing is allowed (`then`, and the choices and watches in it) a step
may wait for what might not come; in a retry, or in `otherwise`, it may not:
it would fail again. So stopping a charge is, generally:

```ts
then: [
  { command: charger off },
  { watch: { condition: supply's power < 10 W, seconds: 5, then: [{ command: supply off }] } },
]
```

— the charger off at once, then the supply only if nothing else draws from
it for 5 seconds; if anything does, or its draw cannot be told, it is left
on.

One addition to what a rule can say besides steps: an expression
**`{ reachable: role }`** — *the part can be reached now*: its holder says it
is connected. True, false, never unknown: not being reachable is itself the
answer. What starts a sequence needs no addition: any automation can be
started — from its card, from a device page it is about, from the home page,
by the assistant, or by another automation — and one with no trigger of its
own (`when: []`) runs only then.

Both tests the language is held to still pass:

1. **It reads as sentences.** A sequence reads as numbered steps:
   > 1. Turn Station's AC output on.
   > 2. Wait until Charger plug can be reached — at most 2 min.
   > 3. Turn Charger plug on.
   > 4. Make sure Charger plug's power is above 50 W within 20 s; if not, turn
   >    it off, wait 5 s, turn it on, and look again — at most 3 times.
   >
   > If a step does not succeed: turn Charger plug off, then Station's AC
   > output off.

   and in one line, for a list: *"Turn Station's AC output on, wait until
   Charger plug can be reached, turn it on, and make sure it draws over
   50 W."*
2. **It is checked without running.** Every condition is a boolean; every
   duration a number of seconds, bounded — a pause, a watch or a wait at most
   an hour, a try at most 10 minutes, at most 10 tries — whether written as a
   number or as a setting, whose own range must keep within it; minutes are
   not seconds. Nothing in a retry or in `otherwise` waits for what might not
   come. A choice or a watch that does nothing either way is a mistake.
   Conditions a step waits on read and compare only, as `becomes` does: they
   are looked at on every reading while it waits.

## The data model

Taken as the chance to make automations' data what it should be — every fact
a row of its own, with a foreign key to what it is about, so it goes when its
owner goes, and a question like "what uses this device?" is a query, not a
scan of JSON. The database is set aside and started afresh for it
(docs/DATA-MODEL.md).

| Table | What it keeps |
|---|---|
| `automation` | Its own rule (JSON, checked before it is kept), the recipe it was copied from if it was (`made_from`), its clock, whether it may act, how often it keeps things so, **`looked_at`** — when it last looked again (NULL: not since it was made). Its place on a home page is each person's own (`shortcut`). No copy of its last run. |
| `automation_role` | What fills each role: a part of a device, `(automation, role) → (device, part)`, or another automation a step starts, `(automation, role) → starts`; exactly one of the two, foreign keys to each. A device page lists what it can start by asking here (`automation_role_device`). |
| `automation_trigger` | Each `becomes` trigger's state, by its place in the rule: whether it held, since when, whether this hold ran it. Forgotten when the automation starts afresh. |
| `automation_run` | **Every run.** When it started and ended, how it came out, who started it (NULL: its own triggers), the run of another automation whose step started it (`started_by_run`), why, its summary, and — in `detail` — what it read, how its conditions stood and **each step it took**. The unended row is the run in progress: written at every step, so a screen follows it and a restart finds it. **One run of an automation at a time**, held by a unique index on the unended row. Its last run is its latest ended one. |
| `device_switch`, `device_write` | The gateway's memory of each part it switched and each setting it wrote: when, last, and by whom — what the dwell counts from. Rows of the device, gone with it. |

Beside them, `device.picture` (which picture a device shows) became a column
too, and `home_setting` keeps only what the home sets as a whole, by names the schema lists.

- **A run records `steps`**: each with its kind, how deep it is and what it
  is within ("Try 2 of 3", "After a step did not succeed"), what it was, how
  it went — a command: done, already, unverified, refused, failed, would; a
  wait, a watch, making sure: waiting, met, not-met, timed-out; stopped —
  in the gateway's or the engine's words, when it began and ended, and while
  it waits, until when. A run's outcome gains **`running`**, **`stopped`**
  and **`interrupted`**.
- **A restart does not resume a run**: a half-finished sequence of physical
  switches is safer stopped and said than continued blind. A run found
  unended when the server starts is ended as **interrupted**, the step it was
  in as stopped — "Interrupted: the server stopped during *Wait until …*. It
  was not resumed — check what it had switched" — and its `otherwise` is not
  attempted: the world may have moved.
- **The timeline** (`audit`) names each run by its id, with its one line; the
  run itself holds its steps. A person starting or stopping one is on it too.

## The engine

- **One walker for every run.** A run walks its steps in order; a rule of
  commands alone is done at once, as before. A run that takes steps is begun
  as a row, written at every step, and said on the live bus
  (`{ kind: 'automation' }`), so every screen showing it follows it.
- **Waits look every second**, at their condition as it reads now — the
  same evaluation `becomes` uses — and end the moment it is met, at their
  limit, or when the run is stopped.
- **Fresh readings while waiting.** A step that waits on a part's readings
  asks its holder for them to be fresh until the wait ends
  (`DeviceSession.wantFresh(until)`): a plug asked every 15 s is asked every
  2 s for the minute it is watched. What "fresh" costs is the device's
  business — its package decides how often, and for how long at most.
- **Judged on readings taken since.** Once a run has switched a part or
  changed a setting, a step that judges readings — wait until, make sure,
  watch — judges only readings taken after that; a watch waits for them up
  to 15 s before its clock starts. On the owner's chain, Stop charging read
  the station's outlets at 190 W a moment after the charger's plug went off
  — the station's reading from before — and left the supply on.
- **A run's log.** While a run that takes steps runs, every reading of
  every device it uses is kept each time its value or time changes — at the
  time the device took it, and the time the run heard it — with each change
  in whether the device could be reached, and why not. It is heard as each
  device says it (the live bus), whenever a step judges readings or a switch
  is made — so what a step acted on is always there — and every second. The
  run keeps the devices and roles it used, and what each value is, as they
  were: a log stays whole when a device is renamed or removed. Five tables
  (`automation_run_device`, `_role`, `_key`, `_reading`, `_reach`; see
  DATA-MODEL.md); `GET /automations/:id/runs/:runId/log`, or `?format=csv`.
  The minute samples of history cannot say what happened inside a 20 s try.
- **The run log page** (`/automations/:id/runs/:run`, "Run log" in a run's
  Activity): how it came out; every step, those that changed something
  numbered; every value drawn across the run — numbers held from one reading
  to the next, on/off and options as bands, the time a device was out of
  reach shaded, the numbered steps marked on every chart — with a cursor, set
  by a tap or a step, that reads every value at one moment; every reading in
  time order, with how late it was heard; by device, and only what changed;
  and the whole log to download, as a table or raw.
- **`otherwise`** runs when a step does not succeed or someone stops the run:
  each of its steps tried whatever the others do, and not itself stopped.
- **Watching.** An automation that only watches cannot walk a sequence on
  its own: its steps wait for what its own commands would have caused. Asked
  what it would do now, it says — every step, in order — and keeps nothing.
- **Starting and stopping.** `POST /automations/:id/start` and `/stop` — by a
  person, on the timeline with who, or by the assistant (`start`, `stop`).
  Started by a person it runs for real, whatever its mode; by an assistant,
  only once it acts. One that is off, or already running, is refused, in
  words. A run that takes steps started by a clock or a condition goes on by
  itself: the clock does not wait for it.
- **Starting another.** A `start` step starts another automation for real,
  as a person would, and — with `andWait` — waits for it to end, at most
  so long; a run stopped stops the one it waits for. A chain goes at most
  four deep (`CHAIN_LIMIT`), and never back to one already in it: both are
  refused when the rule is checked, and again when it runs.
- **Keeping things so** is for rules that act at once: a sequence is started,
  not kept, and the server refuses a `recheckMinutes` for one.
- **Parts are shared in turn.** A run holds every part it may change until
  it ends, with the runs of its own chain; another automation's run that
  needs one is refused and changes nothing — *"Scooter plug is in use by
  “Start charging”, running now"* — so "Stop charging" cannot pull the plug
  from under "Start charging" as it makes sure (SHARED-PARTS-AND-RESERVE.md).
- **Its summary** leads with what changed, says once what was already so, and
  what it made sure of as the reading it saw: *"All was already so; Scooter
  plug: Power 240 W, at once"*; *"Did not succeed: make sure … — not in 3
  tries — Scooter plug: Power 0.4 W; then turned Scooter plug off, turned
  Garage station — AC outlets off"*.

## The gateway

Unchanged in what it guards — read-only mode, freshness, what is
consequential, verification, the timeline — with one addition: **a run's
allowance.** A command can say it belongs to a run of a sequence:

```ts
type CommandIntent = … & {
  run?: {
    id: string;          // the run
    askedBy: 'user' | 'agent' | null; // who asked for it; null, its own triggers started it
    switches: number;    // how often its rule may switch this part within it
  };
};
```

- The **first** switch of a part in a run meets the dwell of whoever asked for
  the run: a person's (seconds), an assistant's (a minute), or, started by its
  own triggers, an automation's (minutes).
- **Within the run**, the same part may be switched again after the
  gateway's own least gap (`runGapMs`, 3 s), up to what the rule allows — its
  commands to that part, a retry's as often as its tries — and never more
  than the gateway's own ceiling (`runSwitchCeiling`, 12), whatever the rule
  asks.
- **A stale reading** — one late over the network, a device asked too
  seldom — is never switched on: the gateway refuses, and names the parts
  whose readings were stale (`stale`). The run asks those parts for fresh
  readings (`wantFresh`) and waits, at most 15 s, until each has said
  something new, then sends the command once more; none in time, it stays
  refused, as the gateway said.
- Outside the run, nothing changes: the next automation or person to switch
  the part meets the dwell from the run's last switch.
- When the run ends, the engine tells the gateway (`runEnded`), which forgets
  what it counted for it.
- A run's switches are counted in memory: a run does not outlive its process.
- Consent is as for any automation: letting it act was confirmed, and its
  commands go as `actor: 'automation'`. Nobody is asked mid-run.

## The devices

In their packages, through two small additions to the device contract:

- **`DeviceSession.wantFresh?(until: number)`** — someone is waiting on this
  device's readings until then; report as often as it sensibly can. The Tuya
  socket polls every 2 s while wanted, never longer than 5 minutes a time.
  Behind a Zigbee gateway a poll is answered from the gateway's memory, and
  each poll also asks the plug to measure (a refresh, as Smart Life does):
  what changed is pushed within a moment (the plug's README). An app showing
  the device makes the same wish while someone looks (docs/API.md, the live
  stream).
- **Reachability** is the session's health, as now: `connected` is reachable.
  The Tuya socket behind a gateway says *offline — its gateway cannot reach
  it* when the gateway reports the plug gone, and takes none of the gateway's
  remembered answers as readings while that holds: they are the gateway's
  memory, not the plug's word, and its readings age as a silent plug's do.
  Pushes — which only come from the plug — count, and end it.

## The API and the app

- **`AutomationView`** gains `steps` and `otherwise` (its steps in words,
  numbered and nested — `StepLine`), `takesSteps`, `running` (the run in
  progress, step by step, or null), and `lastRun` in place of the copy it
  kept. **`RecipeView`** says whether a recipe takes steps, and its steps
  with its roles named by their labels.
- **Routes:** `POST /automations/:id/start`, `/stop`; `GET
  /automations/:id/runs` (every run, each with its steps); `GET
  /automations?device=` (those a device fills a role of).
- **Live:** a run's progress is published on the live stream
  (`{ type: 'automation', id }`); a screen showing it reads it again at once,
  so it follows a run second by second without polling.
- **The card** of every automation leads with **Start** — asked first while
  it only watches — or **Stop** in red while it runs, beside how long it has run and
  the step it is in. Running, a **Now** panel shows each step as it goes: ✓
  with the device's own words, a spinner and "0:02 of 1:30" with a bar for
  the one it waits in, retries indented under "Try 2 of 3". **What it does**
  lists its steps, numbered, the steps within them under "Each time", "If it
  stays so", and what it does if a step does not succeed in a box of its
  own. **Last run** tells a run in one line and then every step it took;
  **History** merges every run with every change, day by day, each run
  opening to its steps.
- **A device's page** lists, under **Start**, the automations it is part of
  that are not off, each with its Start or Stop and how it last went — so the
  owner starts one where they are looking (`client/src/features/automations`).
  Any may be put on the **home page** as a shortcut too.
- **Making one:** the editor, from nothing or from a recipe copied
  ([AUTOMATION-EDITOR.md](AUTOMATION-EDITOR.md)).

## The recipe

In the shared vocabulary (`packages/automation/src/recipes.ts`), so it fills from any
devices that offer what it asks:

- **`standard.start-charging`** — *Start charging through a switched supply.*
  - Roles: **supply** (`switch`: a station's AC output, or anything switching
    power to the charger's plug), **charger** (`switch` and `powerMeter`: the
    plug the charger is in).
  - Settings: reach within (2 min), charging above (50 W), within (20 s),
    off for (5 s), tries (3), if it never charges (switch both off / leave
    them on).
  - No trigger of its own — it runs when started — and the steps of "The
    challenge", as data.

- **`standard.stop-charging`** — *Stop charging.* The same roles, in
  reverse: the charger's plug off at once; then the supply watched for a few
  seconds (5), and switched off only if nothing else draws more than a
  little (10 W) from it.

Stopping a charge *at a level* stays **"Charge between two levels"**, with
the scooter's battery and the charger plug.

## Defaults for what is not yet decided

- If it never charges: **switch both off** — a supply left running to a
  charger that does not charge only drains the battery. A setting ("If it
  never starts charging").
- The plug's own "after a power cut": left to its owner (**Off**
  recommended, so the sequence decides when the charger gets power).
- Voice ("Hey, start charging"): through the assistant's `start` now, and,
  later, a phone's shortcuts calling `start`.

## Building it

Each step kept typecheck, the unit tests, the architecture ratchet and the
end-to-end tests green, and is tested against simulated devices; the last is
tried on the owner's real station, plug and charger, with the owner watching.

1. **Language** — six kinds of step, `asked` (removed since), `reachable`, the limits;
   `checkRule`, `describeSteps`, `ruleUses`, `ruleCommands` —
   `packages/automation/src/` (`rule.ts`, `check.ts`, `describe.ts`, `reads.ts`);
   tests in `sequences.test.ts`. *Built.*
2. **Data model and contract** — `automation_run`, `automation_role`,
   `automation_trigger`, `looked_at`, `device_switch`/`device_write`,
   `device.picture`; `AutomationRun.steps` and its outcomes; `AutomationView`,
   `RecipeView`, `LiveUpdate` — `packages/store` (`schema.ts`, `automations.ts`,
   `ledger.ts`), `api-contract`. *Built.*
3. **Engine** — the walker, waits, `otherwise`, stop, interrupted on start —
   `packages/automation-engine/src/runs.ts`; `sequences.test.ts`. *Built.*
4. **Gateway** — a run's allowance; its memory as a ledger —
   `packages/gateway`. *Built.*
5. **Devices** — `wantFresh`; the Tuya socket polling while wanted, and not
   taking a gateway's memory while the plug is gone — `device-sdk`,
   `tuya-plug`. *Built.*
6. **API, assistant** — start, stop, runs, by device, the live message —
   `routes/automations.ts`, `routes/assistant.ts`. *Built.*
7. **The recipes** — `standard.start-charging`, `standard.stop-charging`.
   *Built.*
8. **The app** — the card, the run as it goes, the device page's Start, the
   editor — `client/src/features/automations`, `client/app/automations/index.tsx`;
   `e2e/sequences.e2e.ts`. *Built.*
9. **Docs** — this, AUTOMATIONS.md, DATA-MODEL.md, API.md, HANDOFF.md.
10. **On the real chain** — the owner's station, Zigbee plug and scooter
    charger, with the owner watching.
