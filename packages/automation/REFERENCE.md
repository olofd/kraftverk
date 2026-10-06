# The automation language — reference

<!-- Written from the language's own description (packages/automation/src/kinds). Do not edit: run `npm run gen:reference`. -->

Every construct the language has, as a configuration file writes it. The
grammar of expressions, units and the rules a run keeps are in
[README.md](README.md).

## What starts it — triggers

Each trigger is one item under `when`, and any of them may say what it
does itself (below).

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
| `becomes` | a condition: `station.charge < 15 %` | needed |
| `for` | a length of time, `2 min` — 1 s to 168 h | if you like |

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

### Every trigger — what it does, and its name

Every trigger may say what it does itself, under `do`: a run it starts takes those steps in place of the automation’s own — one automation, each side where it is said. And a name, `id`, that steps shared by several triggers read back as `run.trigger`.

| Word | Holds | |
|---|---|---|
| `id` | a name of its own, unique in the automation: letters and digits, from a lowercase letter | if you like |
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

## Conditions and values — expressions

An expression is written as text — `station.charge < 15 %` — wherever
a condition or a value goes. Unknown — a reading not given, a part not
reached — is never taken for true.

| Kind | Written | Is |
|---|---|---|
| A value | `50 W` · `"eco"` · `07:00` | A number — with its unit beside a reading, `50 W`, `15 %` — a time of day, `07:00`, text in quotes, `true` or `false`. |
| A setting | `setting.low` | One of the rule’s settings, by its name: a recipe’s, before it is copied into an automation. |
| A reading | `station.charge` · `charger.power` | What the part filling a role reports now, by what it means: a standard meaning, or a type’s own. Unknown when it has not said, or said too long ago. |
| Can be reached | `charger reachable` | Whether the part filling a role can be reached now: its holder says it is connected. Never unknown — not being reachable is the answer. |
| What the run knows | `run.trigger == "low"` · `run.event.voltage < 200 V` | What the run knows of itself: `run.trigger`, the id of the trigger that started it — `""` when none with an id did; `run.event`, the event a device raised that started it, and `run.event.voltage`, what it carried, as its device declares it — unknown when no event did. |
| Time of day | `time between 23:00 and 05:00` | Whether the owner’s clock is between two times of day, from the first up to the second — across midnight when the second comes first. |
| Ask a package | `acme.weather.sunny(forecast, day = "tomorrow")` | A function a package contributes, over the part filling a role: what the forecast says of tomorrow, the price’s rank. Only where a run may wait for its answer. |
| A function of the language | `min(station.charge, 80 %)` · `clamp(charger.power, 0 W, 2 kW)` | One of the language’s own functions — min, max, clamp, round, floor, ceil, abs — on numbers, each with its unit; the answer in the first one’s unit. |
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
