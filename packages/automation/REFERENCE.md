# The automation language — reference

<!-- Written from the language's own description (packages/automation/src/kinds). Do not edit: run `npm run gen:reference`. -->

Every construct the language has, as a configuration file writes it,
each with examples — and every example here is read and checked by the
language’s tests. The grammar of expressions and the rules a run keeps
are in [README.md](README.md).

## An automation — its parts

An automation in a file is its name and these, each under its key. Each
example is a whole automation, but for its name.

### `uses` — What it uses

Each role, by the name its steps and conditions call it, and what fills it: a device by its key — `device-key.part` for one of its parts; a list of them for a group a `for each` goes through; or `{ automation: key }` for another automation a `start` step starts. What each role must offer is read from what is done with it; say it — `needs:` — or give it a label in the long form. `~` (or `[]` for a group): nothing fills it yet.

```yaml
uses:
  supply: garage-station.outlet.ac
  charger: charger-plug
do:
  - turn on: supply
  - wait until: charger reachable
    at most: 2 min
  - turn on: charger
```

```yaml
uses:
  outlets: [smart-plug, garage-station.outlet.ac]
do:
  - for each: outlet
    in: outlets
    do:
      - turn off: outlet
```

```yaml
uses:
  plug:
    part: smart-plug
    label: The kettle
  morning:
    automation: morning-charge
do:
  - turn on: plug
  - start: morning
```

### `settings` — Its settings

Levels set once and read anywhere in it as `setting.name`: a value alone — `low: 20 %` — or, long, with its title, range and how the app sets it. A number keeps its unit; a length of time is kept in seconds whatever it is written in. A recipe’s copies start from its settings, for their owners to set.

```yaml
settings:
  low: 20 %
  lowFor:
    title: For at least
    value: 2 min
    max: 1 h
uses:
  station: garage-station
  charger: charger-plug
when:
  - becomes: station.charge < setting.low
    for: setting.lowFor
do:
  - turn on: charger
```

```yaml
settings:
  mode:
    title: Then
    value: eco
    options: { eco: Save power, boost: Charge fast }
uses:
  station: garage-station
  charger: charger-plug
when:
  - becomes: station.charge < 50 %
do:
  - if: setting.mode == "boost"
    then:
      - turn on: charger
```

### `memory` — What it remembers

Values kept across runs, restarts and changes to it — written as settings are, each the value it starts from; read as `memory.name`, set by a `remember` step, in its unit and held to its range.

```yaml
memory:
  timesCharged: { value: 0, integer: true, min: 0 }
  lastPower: 0 W
uses:
  charger: charger-plug
do:
  - remember: timesCharged
    as: memory.timesCharged + 1
  - remember: lastPower
    as: charger.power
```

### `inputs` — What it may be given

What another automation’s `start` step may give it, under `with` — each written as a setting is, its value what a run takes when not given, as one a person or a trigger starts does. Read as `given.name`, in its unit. One automation, many uses: "charge to 80 %" and "charge to 100 %" are one charge, given two levels.

```yaml
inputs:
  level: { title: Charge to, value: 80 %, min: 20 %, max: 100 % }
uses:
  station: garage-station
  charger: charger-plug
do:
  - turn on: charger
  - wait until: station.charge >= given.level
    at most: 1 h
  - turn off: charger
```

### `result` — What it answers

The kind of value it answers — one field, written as a setting is, its value what a run that gives none answers. An `answer` step gives it and ends the run; a `start` step that waits for it remembers it, with `remember as`.

```yaml
result: { title: Charge reached, value: 0 % }
uses:
  station: garage-station
do:
  - answer: station.charge
```

### `when` — What starts it

Its triggers: any one starts a run — a time of day, every so often, a condition becoming true, an event a device raises. None: it runs only when you, or another automation, start it.

```yaml
uses:
  station: garage-station
  charger: charger-plug
when:
  - at: "07:00"
    days: weekdays
  - becomes: station.charge < 15 %
    for: 2 min
do:
  - turn on: charger
```

### `while running` — Started again while it runs

What one of its triggers starting it while a run still takes its steps does: `skip` — the start is let go, as when none is written; `restart` — the run is stopped, its `if a step fails` steps taken, and it starts afresh; `queue` — it starts again once the run ends, at most 10 waiting.

```yaml
while running: restart
uses:
  mains: garage-station.input.ac
  light: hall-light
when:
  - event: mains.lost
    from: mains
do:
  - turn on: light
  - wait: 5 min
  - turn off: light
```

### `only if` — Only if

A condition that must hold for a run to do anything, whatever started it. Unknown is not true: it does nothing, and says why.

```yaml
uses:
  station: garage-station
  charger: charger-plug
when:
  - at: "23:00"
only if: station.charge < 80 % and charger reachable
do:
  - turn on: charger
```

### `do` — What it does

Its steps, in order — each below. A trigger may have steps of its own instead (`do:` under it).

```yaml
uses:
  charger: charger-plug
do:
  - turn on: charger
  - wait: 10 s
  - make sure: charger.power > 50 W
    within: 20 s
    tries: 3
    each time:
      - turn off: charger
      - wait: 5 s
      - turn on: charger
```

### `if a step fails` — If a step fails, or you stop it

Steps taken when a step does not succeed, or a person stops the run: each tried, whatever the others do, and none that waits for what might not come.

```yaml
uses:
  supply: garage-station.outlet.ac
  charger: charger-plug
do:
  - turn on: supply
  - turn on: charger
  - wait until: charger.power > 10 W
    at most: 2 min
if a step fails:
  - turn off: charger
  - turn off: supply
```

## What starts it — triggers

Each trigger is one item under `when`, and any of them may say what it
does itself (below).

### `at` — At a time

At a time of day on the automation’s own clock — `07:00`, or by the sun where the home is: `sunset`, `30 min before sunset` — every day, or only on the days it names. A server that was down at that time still runs it within the hour, once.

| Word | Holds | |
|---|---|---|
| `at` | a time of day, `"HH:MM"`, on the automation’s clock | needed |
| `days` | `weekdays`, `weekends`, or a list of `mon` … `sun` | if you like |

```yaml
when:
  - at: "07:00"
```

```yaml
when:
  - at: "22:30"
    days: weekdays
```

```yaml
when:
  - at: "09:00"
    days: [mon, wed, fri]
```

```yaml
when:
  - at: sunset
```

```yaml
when:
  - at: 30 min before sunset
    days: weekdays
```

### `every` — Every so often

Every so many minutes, counted on the owner’s clock from midnight: every 15 min is :00, :15, :30 and :45. Once a slot; a server that was down runs once, at the latest, and does not catch up.

| Word | Holds | |
|---|---|---|
| `every` | a length of time, `2 min` — 5 min to 12 h, in steps of 1 min | needed |

```yaml
when:
  - every: 15 min
```

```yaml
when:
  - every: 1 h
```

### `becomes` — When something holds

When a condition turns true — and, with `for`, has stayed true that long. Reads and comparisons only: it is looked at on every reading, and its hold survives a restart.

| Word | Holds | |
|---|---|---|
| `becomes` | a condition: `station.charge < 15 %` | needed |
| `for` | a length of time, `2 min` — 1 s to 7 d | if you like |

```yaml
when:
  - becomes: station.charge < 15 %
    for: 2 min
```

```yaml
when:
  - becomes: station.charge < 20 %
    for: 2 min
    do:
      - turn on: charger
```

### `event` — When a device says so

When the part filling a role raises an event its description declares: a station’s mains lost, a button pressed.

| Word | Holds | |
|---|---|---|
| `event` | an event the part filling `from` declares: `mains.lost` | needed |
| `from` | a role: what fills it is under `uses` | needed |

```yaml
when:
  - event: mains.lost
    from: station
```

### `arrives` — When someone arrives

When someone comes to a place, as presence says — as far as each shares: a role a person fills, any of a role people fill, or `someone`, anyone of the family; at `home`, the automation’s own, or a role a home, a zone or a room fills. The run knows who as `run.who`.

| Word | Holds | |
|---|---|---|
| `arrives` | who: a role a person fills, or people fill — `{ person: key }`, `{ people: [keys] }` under `uses` — or `someone`, anyone in the family | needed |
| `at` | a place: `home`, the automation’s own, or a role a home, a zone or a space fills — `{ zone: key }`, `{ space: key }` under `uses` | needed |

```yaml
when:
  - arrives: someone
    at: home
```

```yaml
when:
  - arrives: olof
    at: work
```

```yaml
when:
  - arrives: children
    at: school
```

### `leaves` — When someone leaves

When someone leaves a place, as presence says — minutes out of its geofence, not a wobble at its edge: the same `who` and `at` as `arrives`. The run knows who as `run.who`.

| Word | Holds | |
|---|---|---|
| `leaves` | who: a role a person fills, or people fill — `{ person: key }`, `{ people: [keys] }` under `uses` — or `someone`, anyone in the family | needed |
| `at` | a place: `home`, the automation’s own, or a role a home, a zone or a space fills — `{ zone: key }`, `{ space: key }` under `uses` | needed |

```yaml
when:
  - leaves: someone
    at: home
```

```yaml
when:
  - leaves: olof
    at: work
```

### `firstArrives` — When the first arrives

When the first of the family — or, with `of`, of a role people fill — comes to a place none of them was at, as far as each shares: the place going from nobody to somebody. Its state survives a restart.

| Word | Holds | |
|---|---|---|
| `first arrives` | a place: `home`, the automation’s own, or a role a home, a zone or a space fills — `{ zone: key }`, `{ space: key }` under `uses` | needed |
| `of` | a role people fill: `{ people: [keys] }` under `uses` | if you like |
| `for` | a length of time, `2 min` — 1 s to 7 d | if you like |

```yaml
when:
  - first arrives: home
```

```yaml
when:
  - first arrives: home
    of: children
```

### `lastLeaves` — When the last leaves

When the last of the family — or, with `of`, of a role people fill — leaves a place, as far as each shares: the place going from somebody to nobody. "When the last one leaves, set away" is this.

| Word | Holds | |
|---|---|---|
| `last leaves` | a place: `home`, the automation’s own, or a role a home, a zone or a space fills — `{ zone: key }`, `{ space: key }` under `uses` | needed |
| `of` | a role people fill: `{ people: [keys] }` under `uses` | if you like |
| `for` | a length of time, `2 min` — 1 s to 7 d | if you like |

```yaml
when:
  - last leaves: home
```

```yaml
when:
  - last leaves: home
    of: grownUps
```

```yaml
when:
  - last leaves: home
    for: 5 min
```

### `empties` — When a room empties

When a place has nobody in it, whoever was there — by what stands in it: motion, a presence radar, a door shut with someone inside, a count — and, with `for`, has had nobody that long.

| Word | Holds | |
|---|---|---|
| `empties` | a place: `home`, the automation’s own, or a role a home, a zone or a space fills — `{ zone: key }`, `{ space: key }` under `uses` | needed |
| `for` | a length of time, `2 min` — 1 s to 7 d | if you like |

```yaml
when:
  - empties: bathroom
    for: 10 min
```

```yaml
when:
  - empties: home
```

### `occupied` — When someone is in a room

When a place has someone in it, whoever they are — by what stands in it — and, with `for`, has had that long.

| Word | Holds | |
|---|---|---|
| `is occupied` | a place: `home`, the automation’s own, or a role a home, a zone or a space fills — `{ zone: key }`, `{ space: key }` under `uses` | needed |
| `for` | a length of time, `2 min` — 1 s to 7 d | if you like |

```yaml
when:
  - is occupied: hallway
```

```yaml
when:
  - is occupied: office
    for: 5 min
```

### `modeBecomes` — When the mode becomes

When a home goes into a mode, by its key — whoever set it: a person, another automation, a vacation beginning as planned. The automation’s own home, unless `at` names another.

| Word | Holds | |
|---|---|---|
| `mode becomes` | a mode, by its key: `home`, `away`, `vacation`, `day`, `evening`, `night`, or one of the family’s own | needed |
| `at` | a place: `home`, the automation’s own, or a role a home, a zone or a space fills — `{ zone: key }`, `{ space: key }` under `uses` | if you like |

```yaml
when:
  - mode becomes: away
```

```yaml
when:
  - mode becomes: night
```

```yaml
when:
  - mode becomes: vacation
    at: cabin
```

### `modeChanges` — When the mode changes

When a home’s mode on an axis — `presence` or `day` — changes, to whichever: what to do as evening comes, and again as night does, read from `home.day`.

| Word | Holds | |
|---|---|---|
| `mode changes` | one of `presence`, `day` | needed |
| `at` | a place: `home`, the automation’s own, or a role a home, a zone or a space fills — `{ zone: key }`, `{ space: key }` under `uses` | if you like |

```yaml
when:
  - mode changes: day
```

```yaml
when:
  - mode changes: presence
    at: cabin
```

### Every trigger — what it does, and its name

Every trigger may say what it does itself, under `do`: a run it starts takes those steps in place of the automation’s own — one automation, each side where it is said. A name, `id`, that steps shared by several triggers read back as `run.trigger`. And `at most every`: a start it would make sooner than that after its last is let go — a minute to a week, a number or a setting.

| Word | Holds | |
|---|---|---|
| `id` | a name of its own, unique in the automation: letters and digits, from a lowercase letter | if you like |
| `at most every` | a length of time, `2 min` — 1 min to 7 d; a number or a setting, never a reading | if you like |
| `do` | steps | if you like |

```yaml
when:
  - becomes: station.charge < 20 %
    for: 2 min
    do:
      - turn on: charger
```

```yaml
when:
  - id: low
    becomes: station.charge < 20 %
```

```yaml
when:
  - becomes: charger.power > 10 W
    at most every: 30 min
```

## What it does — steps

Each step is one item under `do` (and `if a step fails`), in order. A
rule of commands and settings alone does everything at once; one that
waits takes as long as its steps allow, and never longer: every wait has
its limit, every retry its count.

### `turn on`, `turn off`, `switch`, `send` — Switch or send

A command to the part filling a role, through the gateway, as any command is — checked, confirmed where it must be, and verified against what the device reports.

| Word | Holds | |
|---|---|---|
| `to` | a role: what fills it is under `uses` | needed |
| `capability` | a name its part declares | needed |
| `send` | a name its part declares | needed |
| `with` | each argument by its name: a value, or an expression | needed |

```yaml
do:
  - turn on: charger
```

```yaml
do:
  - switch: charger
    on: station.charge < 30 %
```

```yaml
do:
  - send: set
    to: charger
    capability: switch
    with:
      on: true
```

### `set` — Change a setting

Change a setting the part filling a role offers, through the gateway, read back as any setting is — by its key, or by a standard meaning a recipe can name without knowing the product. Never one its device declares dangerous.

| Word | Holds | |
|---|---|---|
| `set` | a role: what fills it is under `uses` | needed |
| `setting` | a name its part declares | if you like |
| `meaning` | a name its part declares | if you like |
| `to` | a value, or an expression for one | needed |

```yaml
do:
  - set: plug
    setting: liveReadings
    to: true
```

```yaml
do:
  - set: station
    meaning: chargeLimit
    to: 80 %
```

### `set mode` — Set the mode

Put a home in a mode, by its key — the automation’s own home, unless `at` names another — as a person would from its screen: said on the home’s timeline as the automation’s, and to every automation that waits for it. Already in it, nothing changes.

| Word | Holds | |
|---|---|---|
| `set mode` | a mode, by its key: `home`, `away`, `vacation`, `day`, `evening`, `night`, or one of the family’s own | needed |
| `at` | a place: `home`, the automation’s own, or a role a home, a zone or a space fills — `{ zone: key }`, `{ space: key }` under `uses` | if you like |

```yaml
do:
  - set mode: away
```

```yaml
do:
  - set mode: night
```

```yaml
do:
  - set mode: home
    at: cabin
```

### `notify` — Tell someone

Tell people something — a role a person fills, a role people fill, or `everyone` in the family — in their inbox, and pushed to their phones and browsers: a `title`, more `text` if you like, as news unless `level` says `warning` or `alarm`. A value in braces is said as it is then, in its unit: `{station.charge}`, `{run.who}`. In watch mode it is said, not sent.

| Word | Holds | |
|---|---|---|
| `notify` | who: a role a person fills, or people fill — `{ person: key }`, `{ people: [keys] }` under `uses` — or `everyone`, everyone in the family | needed |
| `title` | words of your own, at most 120 characters — a value in braces said as it is then: `{station.charge}` | needed |
| `text` | words of your own, at most 1000 characters — a value in braces said as it is then: `{station.charge}` | if you like |
| `level` | one of `info`, `warning`, `alarm` | if you like |

```yaml
do:
  - notify: everyone
    title: Nobody is home, and the door is open
```

```yaml
do:
  - notify: olof
    title: "{home.people} of you are home"
```

```yaml
do:
  - notify: grownUps
    title: The station is at {station.charge}
    level: warning
```

### `wait` — Pause

A pause, before the next step: at most an hour.

| Word | Holds | |
|---|---|---|
| `wait` | a length of time, `2 min` — 1 s to 1 h; a number or a setting, never a reading | needed |

```yaml
do:
  - wait: 5 s
```

```yaml
do:
  - wait: 2 min
```

### `wait until` — Wait until

Wait until a condition is true — judged on readings taken since the run last changed something — or stop, not having succeeded, once it has waited that long.

| Word | Holds | |
|---|---|---|
| `wait until` | a condition: `station.charge < 15 %` | needed |
| `at most` | a length of time, `2 min` — 1 s to 1 h; a number or a setting, never a reading | needed |

```yaml
do:
  - wait until: charger reachable
    at most: 2 min
```

### `wait for` — Wait for an event

Wait until the part filling a role raises an event its description declares — one raised after the step began — or stop, not having succeeded, once it has waited that long.

| Word | Holds | |
|---|---|---|
| `wait for` | an event the part filling `from` declares: `mains.lost` | needed |
| `from` | a role: what fills it is under `uses` | needed |
| `at most` | a length of time, `2 min` — 1 s to 1 h; a number or a setting, never a reading | needed |

```yaml
do:
  - wait for: mains.restored
    from: station
    at most: 30 min
```

### `make sure` — Make sure

Make sure a condition comes true within a time; if not, take the steps under `each time` and look again, at most `tries` times — then the run stops, not having succeeded.

| Word | Holds | |
|---|---|---|
| `make sure` | a condition: `station.charge < 15 %` | needed |
| `within` | a length of time, `2 min` — 1 s to 10 min; a number or a setting, never a reading | needed |
| `tries` | how many times, 1 to 10; a number or a setting | needed |
| `each time` | steps — none that waits for what might not come; at least one | needed |

```yaml
do:
  - make sure: charger.power > 50 W
    within: 20 s
    tries: 5
    each time:
      - turn off: charger
      - wait: 5 s
      - turn on: charger
```

### `if` — If

One way or the other, as a condition is now. Unknown is not true: `else`.

| Word | Holds | |
|---|---|---|
| `if` | a condition: `station.charge < 15 %`, which may ask a package | needed |
| `then` | steps | needed |
| `else` | steps | if you like |

```yaml
do:
  - if: station.charge < 20 %
    then:
      - turn on: charger
    else:
      - turn off: charger
```

### `watch` — Watch

Watch a condition for a while: the steps under `if it stays so` if it stays true all that time, those under `if not` the moment it is not — or cannot be told.

| Word | Holds | |
|---|---|---|
| `watch` | a condition: `station.charge < 15 %` | needed |
| `for` | a length of time, `2 min` — 1 s to 1 h; a number or a setting, never a reading | needed |
| `if it stays so` | steps | if you like |
| `if not` | steps | if you like |

```yaml
do:
  - watch: supply.power < 10 W
    for: 5 s
    if it stays so:
      - turn off: supply
```

### `repeat` — Repeat

Take the steps under `do` again and again: `repeat` times — or, with `until`, until it is so after a round, at most that many; still not so after the last, the run stops, not having succeeded.

| Word | Holds | |
|---|---|---|
| `repeat` | how many times, 1 to 100; a number or a setting | needed |
| `until` | a condition: `station.charge < 15 %`, which may ask a package | if you like |
| `do` | steps; at least one | needed |

```yaml
do:
  - repeat: 3
    do:
      - turn on: charger
      - wait: 10 s
      - turn off: charger
```

```yaml
do:
  - repeat: 5
    until: charger.power > 50 W
    do:
      - turn on: charger
      - wait: 20 s
```

### `for each` — For each

Take the steps under `do` for each part filling a group role — one after the other, or, with `together: true`, all at the same time — each called by the name after `for each` within them, as a role is. One that does not succeed: the others, together, go on to their end; one after the other, the rest are not taken.

| Word | Holds | |
|---|---|---|
| `for each` | a name of its own, as a role’s: what its steps call each part, in turn | needed |
| `in` | a role several parts fill: a list of them under `uses` | needed |
| `together` | `true` or `false`; `false` when it is not written | if you like |
| `do` | steps; at least one | needed |

```yaml
do:
  - for each: outlet
    in: outlets
    do:
      - turn on: outlet
```

```yaml
do:
  - for each: outlet
    in: outlets
    together: true
    do:
      - turn on: outlet
      - wait until: outlet.power > 10 W
        at most: 1 min
```

### `try` — Try

Try the steps under `try`: one that does not succeed ends them, and the steps under `if it fails` are taken — none, and it goes on as if it had succeeded. The run goes on after it either way, unless what it took after a failure did not succeed. A stop is not caught.

| Word | Holds | |
|---|---|---|
| `try` | steps; at least one | needed |
| `if it fails` | steps — none that waits for what might not come | if you like |

```yaml
do:
  - try:
      - turn on: charger
    if it fails:
      - turn off: supply
```

```yaml
do:
  - try:
      - wait until: charger reachable
        at most: 1 min
```

### `stop` — Stop here

End the run here, saying why: as it went — or, with `failed: true`, as not having succeeded, its `if a step fails` steps taken. Within `try`, a failure is the `if it fails` steps’ to answer.

| Word | Holds | |
|---|---|---|
| `stop` | words of your own, said as written | needed |
| `failed` | `true` or `false`; `false` when it is not written | if you like |

```yaml
do:
  - stop: Already charged
```

```yaml
do:
  - stop: The charger did not answer
    failed: true
```

### `answer` — Answer

End the run, answering with a value of the kind the automation’s `result` says, in its unit: what a run that started it with `and wait` remembers, with `remember as`.

| Word | Holds | |
|---|---|---|
| `answer` | a value, or an expression for one | needed |

```yaml
do:
  - answer: charger.power
```

```yaml
do:
  - answer: memory.lastPower * 2
```

### `start` — Start another automation

Start the automation filling a role, as a person’s play would — given its inputs under `with`, the rest their defaults — and, with `and wait`, wait until its run ends: done if it acted, not if it did not, or not within that time. Waited for, what it answers is remembered, with `remember as`, as one of what this automation remembers.

| Word | Holds | |
|---|---|---|
| `start` | a role another automation fills: `{ automation: key }` under `uses` | needed |
| `with` | each argument by its name: a value, or an expression | if you like |
| `and wait` | a length of time, `2 min` — 1 s to 1 h; a number or a setting, never a reading | if you like |
| `remember as` | one of what it remembers, by its name: under `memory` | if you like |

```yaml
do:
  - start: chargeTheScooter
```

```yaml
do:
  - start: chargeTheScooter
    and wait: 10 min
```

```yaml
do:
  - start: chargeTheScooter
    with:
      level: 90 %
    and wait: 30 min
    remember as: lastPower
```

### `run script` — Run a script

Run one of the steps of the script filling a role (docs/PLAN-SCRIPTS.md): given its inputs under `with`, the rest their defaults. It may read the home, act — through the gateway, as this automation, for the person who let it act — and wait, within its run; in watch mode it says what it would do. What it answers is remembered, with `remember as`, as one of what this automation remembers. `step` says which of its steps, when it has several.

| Word | Holds | |
|---|---|---|
| `run script` | a role one of the family’s scripts fills: `{ script: key }` under `uses` | needed |
| `step` | a name its part declares | if you like |
| `with` | each argument by its name: a value, or an expression | if you like |
| `remember as` | one of what it remembers, by its name: under `memory` | if you like |

```yaml
do:
  - run script: tidy
```

```yaml
do:
  - run script: tidy
    step: tidyUp
    with:
      after: 10 min
    remember as: lastPower
```

### `remember` — Remember

Remember a value — kept until a run remembers another, across runs and restarts — read as `memory.<name>`: one of what the automation declares under `memory`, in its kind and unit.

| Word | Holds | |
|---|---|---|
| `remember` | one of what it remembers, by its name: under `memory` | needed |
| `as` | a value, or an expression for one | needed |

```yaml
do:
  - remember: timesCharged
    as: memory.timesCharged + 1
```

```yaml
do:
  - remember: lastPower
    as: charger.power
```

## Conditions and values — expressions

An expression is written as text — `station.charge < 15 %` — wherever
a condition or a value goes. Unknown — a reading not given, a part not
reached — is never taken for true.

| Kind | Written | Is |
|---|---|---|
| A value | `50 W` · `"eco"` · `07:00` | A number — with its unit beside a reading, `50 W`, `15 %` — a time of day, `07:00`, text in quotes, `true` or `false`. |
| A setting | `setting.low` | One of the rule’s settings, by its name: a recipe’s, before it is copied into an automation. |
| What it was given | `given.level` | One of the automation’s inputs, as the step that started the run gave it — or, not given, its default. |
| What it remembers | `memory.timesCharged` | A value it remembers, as a run last left it — or, before any did, as it starts: kept across runs and restarts. |
| A reading | `station.charge` · `charger.power` · `home.people == 0` · `bathroom.occupied` · `home.presence == "vacation"` · `home.day == "night"` | What the part filling a role reports now, by what it means: a standard meaning, or a type’s own. Unknown when it has not said, or said too long ago. Of a place — a role a place fills, or `home`, the automation’s own — what is so of it now: `people`, how many of the family are there, as far as each shares; `occupied`, whether anyone is, whoever they are; `presence` and `day`, a home’s mode on each axis, by its key. |
| Someone somewhere | `olof at home` · `not olof at work` · `any(p in children: p at school)` · `count(p in children: p at home) == 0` | Whether a person is at a place now, as far as they share — a home or a zone by where what they carry says they are, a room by a signal that tells people apart: a role a person fills, or what `any(p in children: …)` calls each of several; a role a place fills, or `home`. Unknown when they share too little to say. |
| Over the time just gone | `average(station.charge, 1 h)` · `change(station.charge, 30 min) > 5 %` · `ago(charger.power, 10 min)` | A reading over the time just gone, from what the home kept of it: `average`, `lowest`, `highest`, `change` — how much it changed — or `ago`, what it was then. In the reading’s unit; the time a number or a setting, a minute to two weeks. Unknown when nothing was kept for that time. |
| How far | `distance(phone.position) < 500 m` · `distance(phone.position) > 2 km` · `distance(phone.position, car.position) < 50 m` | How far the position a part reports is from the home — or from another part’s, given a second — over the Earth’s surface: a number in m, compared in any length. Unknown when either position is, or the home has not said where it is. |
| Can be reached | `charger reachable` | Whether the part filling a role can be reached now: its holder says it is connected. Never unknown — not being reachable is the answer. |
| What the run knows | `run.trigger == "low"` · `run.event.voltage < 200 V` · `run.who == "Anna"` | What the run knows of itself: `run.trigger`, the id of the trigger that started it — `""` when none with an id did; `run.event`, the event a device raised that started it, and `run.event.voltage`, what it carried, as its device declares it — unknown when no event did; `run.who`, the name of the person whose arriving or leaving started it — `""` when none did. |
| Time of day | `time between 23:00 and 05:00` | Whether the owner’s clock is between two times of day, from the first up to the second — across midnight when the second comes first. |
| The sun | `sunset` · `30 min before sunset` · `time between sunset and sunrise` · `time between 1 h after sunrise and setting.lead before sunset` | When the sun rises or sets where the home is, on the automation’s clock — or so long before or after, a minute to twelve hours: a time of day, as `07:00` is, for `at` and `time between`. Unknown until the home has a place, and on a day the sun does not cross the horizon. |
| Across a group | `any(c in chargers: c.power > 10 W)` · `count(c in chargers: c reachable) < 2` · `sum(c in chargers: c.power ?? 0 W) > 2 kW` | Something of each part of a group, taken together — `all`, `any`, `count`, `sum`, `average`, `lowest`, `highest` — each part called by a name of its own within it, as a role is. Unknown while it is for a part, unless one part settles it; `??` gives a part that may not say a value of its own. |
| Ask a package | `acme.weather.sunny(forecast, day = "tomorrow")` | A function a package contributes, over the part filling a role: what the forecast says of tomorrow, the price’s rank. Only where a run may wait for its answer. |
| A function of the language | `min(station.charge, 80 %)` · `clamp(charger.power, 0 W, 2 kW)` | One of the language’s own functions — min, max, clamp, round, floor, ceil, abs — on numbers, each with its unit; the answer in the first one’s unit. |
| A function of a script | `feel.feelsLike(kitchen.temperature, kitchen.humidity) > 25 °C` | One of the functions of the script filling a role (docs/PLAN-SCRIPTS.md), its arguments in order: pure, so it may be called anywhere a condition is looked at. Unknown when an argument is, or where no engine runs scripts. |
| A comparison | `station.charge < 15 %` | Two values compared: `<`, `<=`, `>`, `>=`, `==`, `!=`. Unknown when either is. |
| One of | `station.mode in ["eco", "boost"]` | Whether a value is one of a list: numbers in one unit, or texts. |
| Arithmetic | `station.charge + 10 %` · `station.capacity * 50 %` · `charger.power * 2 h` | A number from two: `+ - * /`. A sum is in one unit; a product or quotient in the unit the two make — a power for a time an energy, a percentage a share of what it multiplies. Unknown when either is. |
| The opposite | `-meter.power` | A number’s opposite, in its unit. |
| One or the other | `price.priceRank <= 4 ? 2 kW : 500 W` | The first value when the condition holds, the second when it does not; unknown when it cannot be told. |
| The first known | `outdoor.temperature ?? 10 °C` | The first of its values that is known: a reading gone quiet, a value in its place. |
| All of | `charger reachable and station.charge < 50 %` | True when every part is: one false is enough to say no, and with none false, one unknown leaves it unknown. |
| Any of | `station.charge < 10 % or time between 23:00 and 05:00` | True when any part is: one true is enough, and with none true, one unknown leaves it unknown. |
| Not | `not charger reachable` | True when its part is false, false when it is true; unknown stays unknown. |

### The language’s own functions

Each takes numbers, each with its unit, and answers in the first one’s unit. Unknown when any argument is.

| Function | Written | Is |
|---|---|---|
| `min(a, b, …)` — The lowest | `min(station.charge, 80 %)` · `min(a.power, b.power, 2 kW)` | The lowest of two or more numbers, in the first one’s unit. |
| `max(a, b, …)` — The highest | `max(station.charge, 20 %)` | The highest of two or more numbers, in the first one’s unit. |
| `clamp(x, low, high)` — Keep between | `clamp(charger.power, 0 W, 2 kW)` | A number kept between two others: below the low one, the low one; above the high one, the high one. All in the first one’s unit. |
| `round(x, digits)` — Round | `round(station.charge)` · `round(charger.power, 1)` | A number rounded to a whole one — or, given `digits`, to that many decimals. In its own unit. |
| `floor(x)` — Round down | `floor(station.charge)` | A number rounded down to a whole one, in its own unit. |
| `ceil(x)` — Round up | `ceil(station.charge)` | A number rounded up to a whole one, in its own unit. |
| `abs(x)` — Size | `abs(meter.power)` | How large a number is, whichever way: −5 W is 5 W. |

### Across a group

Each takes something of each part of a group — `name in group:`, the name what is said of each calls it — and takes them together. Unknown while it is for a part, unless one part settles it; numbers in the first one’s unit.

| Function | Written | Is |
|---|---|---|
| `all(x in group: …)` — All of them | `all(c in chargers: c.power < 5 W)` | Whether something holds for every part of a group: one that does not is enough to say no; with none that does not, one that cannot tell leaves it unknown. |
| `any(x in group: …)` — Any of them | `any(c in chargers: c.power > 10 W)` · `any(c in chargers: not c reachable)` | Whether something holds for at least one part of a group: one that does is enough; with none that does, one that cannot tell leaves it unknown. |
| `count(x in group: …)` — How many | `count(c in chargers: c.power > 10 W) >= 2` | How many parts of a group something holds for: a plain number — unknown while it cannot be told for one. |
| `sum(x in group: …)` — The sum | `sum(c in chargers: c.power) > 2 kW` · `sum(c in chargers: c.power ?? 0 W)` | A number of each part of a group, added up, in the first one’s unit — each converted to it. Unknown while one is not known: `?? 0 W` counts one that is not as nothing. |
| `average(x in group: …)` — The average | `average(b in batteries: b.charge) < 30 %` | The average of a number of each part of a group, in the first one’s unit. Unknown while one is not known. |
| `lowest(x in group: …)` — The lowest | `lowest(b in batteries: b.charge) < 10 %` | The lowest of a number of each part of a group, in the first one’s unit. Unknown while one is not known. |
| `highest(x in group: …)` — The highest | `highest(c in chargers: c.power) > 1 kW` | The highest of a number of each part of a group, in the first one’s unit. Unknown while one is not known. |

### Over the time just gone

Each looks back at a reading — `role.meaning` — for a length of time, from 1 min to 14 d: a number or a setting. Each value counts from when it was read until the next; the answer is in the reading’s unit, unknown when nothing was kept for that time.

| Function | Written | Is |
|---|---|---|
| `average(reading, time)` — The average | `average(station.charge, 1 h)` · `average(charger.power, setting.window) > 50 W` | The average of a reading over the time just gone, each value weighed by how long it held — in the reading’s unit. |
| `lowest(reading, time)` — The lowest | `lowest(station.charge, 1 d) < 10 %` | The lowest a reading was over the time just gone, in its unit. |
| `highest(reading, time)` — The highest | `highest(charger.power, 10 min) < 5 W` | The highest a reading was over the time just gone, in its unit. |
| `change(reading, time)` — How much it changed | `change(station.charge, 30 min) > 5 %` | How much a reading changed over the time just gone: now, less what it was then — in its unit; unknown when either is. |
| `ago(reading, time)` — What it was then | `ago(station.charge, 10 min)` | What a reading was, so long ago — in its unit; unknown when nothing was kept of it then. |

### Units

A number may carry one of these, written after it — `50 W`, `1.5 kWh`, `2 min`. Any other is refused where it is written. Numbers of one quantity are converted to each other as they are compared or added; a product or quotient makes the unit the two make (a power for a time is an energy).

| Unit | Is | Of | Written |
|---|---|---|---|
| `W` | watts | power | `50 W` |
| `kW` | kilowatts | power | `50 kW` |
| `MW` | megawatts | power | `50 MW` |
| `Wh` | watt-hours | energy | `1.5 Wh` |
| `kWh` | kilowatt-hours | energy | `1.5 kWh` |
| `MWh` | megawatt-hours | energy | `1.5 MWh` |
| `A` | amperes | current | `6 A` |
| `mA` | milliamperes | current | `6 mA` |
| `V` | volts | voltage | `230 V` |
| `mV` | millivolts | voltage | `230 mV` |
| `kV` | kilovolts | voltage | `230 kV` |
| `Hz` | hertz | frequency | `50 Hz` |
| `kHz` | kilohertz | frequency | `50 kHz` |
| `s` | seconds | time | `2 s` |
| `min` | minutes | time | `2 min` |
| `h` | hours | time | `2 h` |
| `d` | days | time | `2 d` |
| `%` | percent | ratio | `20 %` |
| `°C` | degrees Celsius | temperature | `21 °C` |
| `°F` | degrees Fahrenheit | temperature | `21 °F` |
| `K` | kelvin | temperature | `21 K` |
| `mm` | millimetres | length | `12 mm` |
| `cm` | centimetres | length | `12 cm` |
| `m` | metres | length | `12 m` |
| `km` | kilometres | length | `12 km` |
| `mi` | miles | length | `12 mi` |
| `m/s` | metres a second | speed | `25 m/s` |
| `km/h` | kilometres an hour | speed | `25 km/h` |
| `mph` | miles an hour | speed | `25 mph` |
| `W/m²` | watts a square metre | irradiance | `800 W/m²` |
| `dBm` | decibel-milliwatts | signal | `-60 dBm` |
| `lx` | lux | illuminance | `300 lx` |
| `°` | degrees | angle | `59.3 °` |
| `EUR/kWh` | euros a kilowatt-hour | price.EUR | `0.25 EUR/kWh` |
| `SEK/kWh` | kronor a kilowatt-hour | price.SEK | `1.5 SEK/kWh` |
| `NOK/kWh` | Norwegian kroner a kilowatt-hour | price.NOK | `1.5 NOK/kWh` |
| `DKK/kWh` | Danish kroner a kilowatt-hour | price.DKK | `1.5 DKK/kWh` |
