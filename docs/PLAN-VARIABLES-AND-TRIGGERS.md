# Plan: home variables and a family of triggers

*Plan, 2026-10-09. The first two of the ten things
[RESEARCH-HOME-ASSISTANT.md](RESEARCH-HOME-ASSISTANT.md) says to build to
surpass Home Assistant: typed state of the home's own that automations,
people and scripts share, and the triggers a power user misses. Decisions
for the owner are in §6; everything else follows from the code as it is
(file references as of `c7c334a`).*

## 1. What it is for

Today an automation's only state is its own `memory`. Nothing is shared:
not "guests are staying", not "how many times the dryer ran", not "wake me
at 06:45 on workdays", not "the laundry timer". Home Assistant has helpers
for this; Hubitat has hub variables; Homey has logic variables. Kraftverk's
version must be what theirs are not: **typed** (units, ranges, choices —
checked before anything runs), **said in sentences**, **on the timeline**,
**in the history** (so `average(...)` works on them), and **one model** for
automations, people in the app, and scripts.

And the triggers that power users reach for first and kraftverk lacks:
"when it changes", a webhook, an MQTT topic, when the hub starts, dates and
months, a time of day taken from something, and `every` below 5 minutes.

## 2. Variables

### 2.1 The word

"Values" is taken: the policy's values (load watts, the reserve) are "the
home's values" in CONFIG.md and DATA-MODEL.md, and `HomeValue` is banned by
the architecture check (it named the old root). So: **variables**, the word
Hubitat and Homey use. In the language `home.var.guests`; in the app "Your
home's variables"; in the file `variables:` under a home.

### 2.2 Kinds

Each is a `ConfigField` (the shape `settings`, `memory` and `inputs`
already use — `text/settings.ts`), plus a kind that says how it changes:

| Kind | Holds | Set by | Notes |
| --- | --- | --- | --- |
| `toggle` | yes / no | step, person, script | "Guests are staying" |
| `number` | a number, in a unit, within a range | step, person, script | "Target temperature: 21 °C" |
| `choice` | one of its options | step, person, script | "Laundry: washing · drying · done" |
| `text` | words | step, person, script | A note for the family |
| `time` | a time of day | step, person, script | `at: home.var.wakeUp` |
| `counter` | a whole number, from its start | `count` step, person, script | Up, down, reset; its own min and max |
| `timer` | its state and what is left | `start timer` / `stop timer`, person | Ends on its own: `becomes: home.var.laundry is ended` |
| `schedule` | yes / no, by the week | its blocks, person | "Quiet hours": Mon–Fri 22:00–07:00 |
| `derived` | what an expression says, now | nobody: it is worked out | `home.var.feelsLike = feelsLike(...)`, typed by its expression |

A derived variable is the "template sensor" Home Assistant users build by
the dozen — here typed, checked, and with a sentence.

### 2.3 Where it lives (one database, no migration chain: the schema changes in place)

- **`variable`** — `id` (`v-…`), `home_id` (a variable is a home's, as its
  modes are), `key`, `name`, `kind`, `field` (the `ConfigField` as JSON),
  `expr` (a derived one's), `schedule` (a schedule's weekly blocks),
  `created_at`, `removed_at`. Unique `(home_id, key)`.
- **`variable_value`** — its current value: `value` JSON, `set_at`,
  `set_by` (actor), `cause` (the automations whose runs led to it — the
  loop guard modes use), and a timer's `deadline` and `paused_left`.
- **`variable_sample`** — its history: `(variable_id, at, value, text)`,
  as `sample` is for a device's reading, kept as long; hourly aggregates
  beside it as `sample_hour`. Recorded on every change, and each minute
  for numbers (the `Sampler`'s rhythm).
- **The timeline:** `RESOURCE_KINDS` gains `'variable'` (and the `audit`
  CHECK with it): `variable.added|changed|removed` for definitions;
  `variable.set` for a value set by a person (an automation's set is its
  run's line, as `set mode` is).

### 2.4 The hub

A **`Variables`** controller beside `Modes` (`hub/src/modes/modes.ts` is the
pattern):

- `set(homeId, key, value, by, cause)` — the value checked against its
  field (`toRemember`'s conversion and range), kept, sampled, said on the
  bus: **`{ kind: 'variable', homeId, key, value, previous, by, cause }`**.
- `count(…, by)`, `startTimer(…, seconds)`, `stopTimer`, `pauseTimer`.
- A timer's deadline and a schedule's next block are found by one
  `nextChange()` and kept by one clock timeout, as modes' planned
  intervals are (`#again`), so a timer ends to the second and survives a
  restart (its deadline is in the table).
- **Derived variables** are worked out by the engine's evaluator: each is
  indexed by what it reads (`ruleUses` of its expression), worked out again
  when a reading, a mode or a variable it reads moves, and set as any
  variable is — so it has a history, a timeline line when it changes, and
  can be a trigger. A cycle (a derived variable reading itself through
  another) is refused when it is defined.

### 2.5 The language

- **Read:** `home.var.guests` — a new expression kind
  `{ variable: { at: 'home' | <place role>, key } }`, typed from the
  vocabulary (`RuleVocabulary.variables?(at)` → its `ConfigField`) as
  `memory.x` is typed from `memory:`. `cabin.var.guests` for a home filled
  by a place role. `var` becomes a keyword after a place.
- **History works:** `average(home.var.target, 1 h)`, `home.var.laundry
  ago 10 min` — `EngineHistory` widens from `(deviceId, key)` to a subject,
  `{ device, key } | { variable }`, and the check that refuses lookback on
  a place (`check.ts:358`) lets a variable through.
- **Triggers for free:** `becomes: home.var.guests > 0` and
  `becomes: home.var.laundry is ended` — the world index (`#concerningWorld`,
  `ruleUses().world`) counts variable reads, so the engine looks again when
  one moves, with `cause` guarding loops as modes do.
- **Steps:**
  - `set variable: guests` · `to: home.var.guests + 1` · `at: cabin`
    (its own home when not said) — checked against the variable's type and
    range; refused for a derived one.
  - `count: dryerRuns` · `by: 1` (or `-1`, or `reset: true`).
  - `start timer: laundry` · `for: 45 min`; `stop timer: laundry`.
  None of these touch a device, so none pass the gateway; each is a line in
  the run's log, and changes the home as a mode set does.

### 2.6 People, scripts, the API

- **API:** a `variables` namespace — `list(homeId)`, `add`, `update`,
  `remove` (definitions: `act`, a person's or an assistant's), `set`,
  `count`, `timer` (`scripted`: a script may set them), `history`.
  `LiveUpdate` `{ type: 'world', what: 'variable', homeId }`.
- **The app:**
  - **Home page:** a "Variables" card under the modes (`ModesCard` is the
    pattern) with each pinned variable as its control — a switch, a
    stepper, a choice, a timer with its countdown and start / stop.
  - **A home's settings:** add, change and remove variables: a kind, then
    its field (title, unit, range, options, start), as a form editor's
    settings are made.
  - **Its page:** its value now, its history as a chart, its timeline, the
    automations that read or set it (as a script's "Used by").
  - **The editor:** "A variable" among a condition's kinds; "Set a
    variable", "Count", "Start a timer" among steps; a variable offered
    wherever a value is.
- **Scripts:** `home.vars.guests` — typed per family (a toggle is
  `boolean`, a number `Quantity<'°C'>`, a choice its words) — read through
  `__read`, set by assignment (`home.vars.guests = true`), each set counted
  as a change and passing the gate as `variables.set` (`scripted`).

### 2.7 The file

`homes.<key>.variables:` — each by its key, written as settings are
(`guests: false`, or with `title`, `unit`, `min`, `max`, `options`), plus
`kind:` for a counter, timer, schedule or derived one, `every:` blocks for
a schedule, `is:` an expression for a derived one. **Definitions travel;
current values do not**, as a home's mode does not (`configuration.ts`'s
`CHANGES`): a file is what the home *is*, not what it is *now*. Version 19,
an identity migration, `fixtures/v19.yaml`.

## 3. The triggers

All typed, checked, said and in the file; each with `id`, `do` and
`at most every` as every trigger has (`TRIGGER_FIELDS`).

### 3.1 `changes:` — when something moves

```yaml
- changes: station.power
  by at least: 50 W          # a deadband: noise is not a change
- changes: home.var.laundry
  from: washing              # optional
  to: drying                 # optional
```

- A reading, a variable, or a place's fact. Fires on a change of value,
  never a fresh timestamp (`readings` re-sends unchanged values every 60 s,
  `bus.ts:68`, so the trigger keeps the last value it saw in its
  `TriggerState.last`, which is kept across restarts).
- **Its run knows what moved:** `run.from` and `run.to`, typed as what
  changed — new `RunFact`s, given only where a `changes` trigger can have
  started the run (`gives`, as `run.who` is).
- **Rehearsed:** from the history, at each sample that changed.

### 3.2 `at: start` — when kraftverk starts

- `at: start`, with `after:` (default 1 min: devices reconnect first). Fired
  once per start of the hub process, from `engine.start()` — which today
  only waits for its first tick (`engine.ts:68`) — never by a reload of an
  automation; `at most every` keeps a crash loop from firing it each time.
- Not rehearsed (said so).

### 3.3 Dates and months on `at`

```yaml
- at: "07:00"
  days: weekdays
  months: [dec, jan, feb]
- at: sunset
  dates: ["12-01..12-24"]     # month-day, or a range across a year's end
```

`runsOn` (`clock.ts:50`) learns months and dates; the four codecs learn the
two fields (`check`, the YAML reader and writer, the schema, the form);
`#dueAt` and rehearsal follow.

### 3.4 `at:` a time taken from something

`at: home.var.wakeUp` or `at: phone.alarm` — the engine already evaluates
`at` as an expression (`#dueAt`); what is missing is the check saying so
(a time of day from a variable or a reading of that type), the form drawing
it (today only a fixed time, `Field.tsx:48`), and rehearsal reading it from
the history.

### 3.5 `every` from 1 minute, on time

`EVERY_SECONDS.min` to 60 (`clock.ts:15`, and the words at
`triggers.ts:76`). And clock triggers are scheduled, not found: today a
30 s tick looks for what is due (`#dueEvery`), so a 1-minute `every` could
fire 30 s late. A timeout to the next due moment, per automation, kept by
the engine as holds are.

### 3.6 `webhook:` — a call from outside

```yaml
hooks:                        # the family's, beside scripts
  doorbell:
    payload:
      button: { options: [front, back] }
      battery: { unit: "%" }
automations:
  door:
    when:
      - webhook: doorbell
    only if: run.event.button is front
    do:
      - notify: everyone
        title: Someone at the front door
```

- **Hooks are the family's**, each with a key, its payload declared as
  `inputs` are (typed fields), and a **secret address**:
  `POST /api/hook/<secret>` — a long random token, shown once, kept hashed,
  renewable. The route is open (no session) but answers nothing but 202,
  is held to a rate and a body of at most 16 KB, and drops what the payload
  does not declare; a value that does not fit its field is refused 400
  with the field's words.
- **The bus:** `{ kind: 'hook', hookId, data }`; the trigger fires with
  `run.event.<field>` typed by the hook's payload — the check generalises
  from "an `event` trigger with a device's declaration" (`check.ts:164`,
  `checkBinding:1127`, `context.ts:157`) to "the starting triggers'
  declared payloads".
- **Where it can be:** a server. A home kept in a browser has no address
  to call; the app says so where a hook is made.
- **The app:** a hook's page with its address to copy, a "Send a test"
  button, and its last calls.

### 3.7 `mqtt:` — a topic

- An **MQTT integration** (the transport exists, `packages/transports/mqtt`,
  for device protocols): a connection to the house broker by default, or
  another, with its secrets kept as connections' are.
- `mqtt: zigbee2mqtt/hall/action` (with `+` and `#`), `payload:` declared
  as a hook's (JSON fields, or `text`), and an optional `matches:`
  condition on it. `run.event.<field>` as a hook's.
- Later, a `publish:` step to a topic — through the gateway's allowance, as
  any act is, since a topic can drive a device kraftverk does not see.

## 4. Order of work

Each slice green and pushed; e2e for each in the browser first.

| Slice | What | Why first |
| --- | --- | --- |
| **V1** | Variables: toggle, number, choice, text, time, counter — store, `Variables`, API and gate, bus and live, `home.var.x` read and typed, `set variable` and `count`, `becomes` on them, the app's card, settings and page, scripts, the file (v19) | The shared state everything else leans on |
| **T1** | `changes:` with `run.from` / `run.to`; `at: start`; `months` / `dates`; `at:` a variable or a reading; `every` from 1 min on time | Cheap, all inside the engine and the language; uses V1 (`at: home.var.wakeUp`) |
| **V2** | Timers and schedules; derived variables; history of variables and lookback over them; their charts | Needs V1's controller and T1's `changes` to be worth it |
| **T2** | Hooks: definitions, the open route, secrets, typed payloads generalised to `run.event`, the app's hook page and test | The first trigger from outside |
| **T3** | MQTT: the integration, the trigger, then `publish:` | Needs T2's payloads |

## 5. Tests

- **Language:** each new kind's examples run through the schema and the
  reader (`schema.test.ts` does every example); the check refuses a set of
  the wrong type or out of range, a derived variable set, a cycle, `run.to`
  without a `changes` trigger, a webhook field the hook does not declare.
- **Engine, on the virtual clock:** a timer ends to the second and after a
  restart; a schedule's block turns on and off; `every: 1 min` on the
  minute; `changes` ignores a fresh timestamp and a change inside its
  deadband; `at: start` once per start; a derived variable follows what it
  reads and stops at a cycle.
- **Hub:** setting through the gate as a person, a script (counted as a
  change), an assistant; `variable` on the bus and the timeline; a hook's
  secret, rate and payload refused and accepted.
- **End to end:** add a counter in a home's settings, an automation that
  counts on an event and says the count, run it; a webhook called with
  `curl` starting an automation; the variables card at 375 px.

## 6. Decided (the owner, 2026-10-09)

1. **The word:** variables — `home.var.x`, `variables:`, "Your home's
   variables".
2. **Whose:** each home's, as modes are. A family's own can come later.
3. **The file:** definitions only; current values stay out of it, as a
   home's mode does.
4. **Webhooks:** on the server's own address, as far as the network lets it
   be reached; no relay. A home kept in a browser receives none, and says so.
5. **MQTT:** the house broker first.
