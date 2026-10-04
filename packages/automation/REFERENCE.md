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
