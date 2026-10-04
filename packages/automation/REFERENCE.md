# The automation language — reference

<!-- Written from the language's own description (packages/automation/src/kinds). Do not edit: run `npm run gen:reference`. -->

Every construct the language has, as a configuration file writes it. The
grammar of expressions, units and the rules a run keeps are in
[README.md](README.md).

## What starts it — triggers

Each trigger is one item under `when`. Any of them may carry an `id`
(`id: low`), which what the automation does reads back as
`run.trigger == "low"`.

### `at` — At a time

At a time of day on the automation’s own clock: every day, or only on the days it names. A server that was down at that time still runs it within the hour, once.

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
| `becomes` | a condition: `station.battery.soc < 15 %` | needed |
| `for` | a length of time, `2 min` — 1 s to 168 h | if you like |

```yaml
when:
  - becomes: station.battery.soc < 15 %
    for: 2 min
```

```yaml
when:
  - id: low
    becomes: station.battery.soc < 5 %
    for: 2 min
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
    on: station.battery.soc < 30 %
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
    meaning: battery.chargeLimit
    to: 80 %
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
| `wait until` | a condition: `station.battery.soc < 15 %` | needed |
| `at most` | a length of time, `2 min` — 1 s to 1 h; a number or a setting, never a reading | needed |

```yaml
do:
  - wait until: charger reachable
    at most: 2 min
```

### `make sure` — Make sure

Make sure a condition comes true within a time; if not, take the steps under `each time` and look again, at most `tries` times — then the run stops, not having succeeded.

| Word | Holds | |
|---|---|---|
| `make sure` | a condition: `station.battery.soc < 15 %` | needed |
| `within` | a length of time, `2 min` — 1 s to 10 min; a number or a setting, never a reading | needed |
| `tries` | how many times, 1 to 10; a number or a setting | needed |
| `each time` | steps — none that waits for what might not come; at least one | needed |

```yaml
do:
  - make sure: charger.power.draw > 50 W
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
| `if` | a condition: `station.battery.soc < 15 %`, which may ask a package | needed |
| `then` | steps | needed |
| `else` | steps | if you like |

```yaml
do:
  - if: station.battery.soc < 20 %
    then:
      - turn on: charger
    else:
      - turn off: charger
```

### `watch` — Watch

Watch a condition for a while: the steps under `if it stays so` if it stays true all that time, those under `if not` the moment it is not — or cannot be told.

| Word | Holds | |
|---|---|---|
| `watch` | a condition: `station.battery.soc < 15 %` | needed |
| `for` | a length of time, `2 min` — 1 s to 1 h; a number or a setting, never a reading | needed |
| `if it stays so` | steps | if you like |
| `if not` | steps | if you like |

```yaml
do:
  - watch: supply.power.draw < 10 W
    for: 5 s
    if it stays so:
      - turn off: supply
```

### `start` — Start another automation

Start the automation filling a role, as a person’s play would — and, with `and wait`, wait until its run ends: done if it acted, not if it did not, or not within that time.

| Word | Holds | |
|---|---|---|
| `start` | a role another automation fills: `{ automation: key }` under `uses` | needed |
| `and wait` | a length of time, `2 min` — 1 s to 1 h; a number or a setting, never a reading | if you like |

```yaml
do:
  - start: chargeTheScooter
```

```yaml
do:
  - start: chargeTheScooter
    and wait: 10 min
```
