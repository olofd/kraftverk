# @kraftverk/automation — the automation language

## What it is

One small, typed language for what a kraftverk home does on its own. A
package's recipe, a person's editor, a configuration file and an assistant
all write it; one checker checks it, one describer says it in words, and one
engine (`@kraftverk/automation-engine`) runs it, wherever it is held.

A rule is **data**: it can read, compare, wait, and ask the gateway for a
command or a setting — nothing else. Its words are the device model's
(capabilities, meanings, events, commands) plus the functions packages
contribute. It adds none of its own, so whatever wrote a rule, it can do no
more than a person could from a screen.

## What it does — and does not

- **Does:** the rule as data (triggers, steps, expressions, roles); checking
  a rule and what fills its roles; describing it in words; evaluating a
  condition; editing a rule step by step, and an automation as it is being
  built — its rule, and what fills each role (`AutomationDraft`, `partRole`,
  `pruned`, `draftOfRecipe`); its text form, as a home's file writes it;
  the standard recipes; and what a package contributes
  (`defineContribution`, checked by `checkContribution`).
- **Does not:** run anything — no timers, no runs, no devices. That is
  `@kraftverk/automation-engine`'s. Nor does it keep automations: the
  store's.

## Where it fits

With the rules, just above the contract (docs/PLAN-SHARED-CORE.md): it
depends on `@kraftverk/device-sdk` alone. A device package may import it
to declare recipes and functions; the engine runs it; a home's file writes
it; the app's editor edits it.

## Why a package of its own

Because the same rules are written by packages, people, files and an
assistant, and must mean one thing everywhere. A device package declares
recipes in it without pulling in the engine, and the language is
documented, tested and kept whole in one place — this README is its
reference, and a test fails when a trigger, step or expression is missing
from it (`src/reference.test.ts`).

## Two forms of one rule

**Every construct — each part of an automation (`kinds/parts.ts`), trigger,
step, kind of expression, function of the language and unit — has its page
in [REFERENCE.md](REFERENCE.md), with examples, generated from the
language's own description; and every example there is read, checked and
written back by the tests.** A construct without its page and examples does
not compile, or does not pass.

A rule is a value of type `Rule`. A configuration file (docs/CONFIG.md)
writes the same rule in words; `ruleFromConfig` reads the words into the
value, `ruleToConfig` writes the value back, and the two always agree.

```yaml
# Text form: an automation in a configuration file.
uses:
  supply: { part: station.outlet.ac, label: The station's AC outlets }
  charger: { part: charger-plug, label: The charger's plug }
do:
  - turn on: supply
  - wait until: charger reachable
    at most: 2 min
  - turn on: charger
  - make sure: charger.power > 50 W
    within: 20 s
    tries: 5
    each time:
      - turn off: charger
      - wait: 10 s
      - turn on: charger
if a step fails:
  - turn off: charger
  - turn off: supply
```

```ts
// Data form: the same rule.
const rule: Rule = {
  roles: {
    supply: { label: "The station's AC outlets", capabilities: ['switch'] },
    charger: { label: "The charger's plug", capabilities: ['switch', 'powerMeter'] },
  },
  params: { fields: {} },
  when: [],
  then: [
    { command: { role: 'supply', capability: 'switch', command: 'set', args: { on: { value: true } } } },
    { waitUntil: { condition: { reachable: 'charger' }, atMost: { value: 120 } } },
    { command: { role: 'charger', capability: 'switch', command: 'set', args: { on: { value: true } } } },
    {
      ensure: {
        condition: { compare: 'gt', left: { read: { role: 'charger', means: 'power' } }, right: { value: 50 } },
        within: { value: 20 },
        tries: { value: 5 },
        retry: [/* turn off, wait 10 s, turn on */],
      },
    },
  ],
  otherwise: [/* turn off the charger, then the supply */],
};
```

A rule has:

| Part | Text | What it is |
|---|---|---|
| `roles` | `uses:` | What it works on, by role: a part of a device that offers some capabilities; a group of such parts (`group: true`; a list under `uses`), gone through by a `for each`; or another automation. Filled when the rule becomes an automation. What a `for each` calls each part is read as its group (`eachAsGroup`) by what binds, holds and infers a role. |
| `params` | `settings:` | Its settings: each a field of a form — title, unit, range — whose `default` is the value the rule runs with, read as `setting.name`. A recipe's are what each copy starts from; an automation keeps them (`withSettings`), its owner's to set in one place. `inlineParams` writes them into the blocks, for a rule read with its values in place. |
| `memory` | `memory:` | What it remembers: written as its settings are, each the value it starts from (`timesCharged: 0`, `lastPower: 0 W`), read as `memory.name` and set by a `remember` step. Kept by where it runs, in its field's unit, across runs, restarts and changes to it; a value its field no longer takes is read as the one it starts from. None: it remembers nothing. |
| `inputs` | `inputs:` | What a run may be given — written as settings are, each the value it takes when not given — by another automation's `start` step, under `with:`; read as `given.level`. One automation, many uses. |
| `result` | `result:` | What it answers: one field — its kind and unit, its value the answer of a run that gives none — given by an `answer` step, remembered by a `start` that waits, with `remember as:`. |
| `whileRunning` | `while running:` | What one of its triggers starting it while it runs does: `skip` — let go, as when none is written; `restart` — the run stopped, as a person would, its fallback taken, and started afresh; `queue` — started once the run ends, at most `SEQUENCE_LIMITS.queued` waiting. A person or another automation starting it while it runs is told it is running. |
| `when` | `when:` | What starts a run: any one trigger — each with steps of its own, if it has them (`do:` under it). Empty: it runs only when a person plays it or another automation starts it. |
| `if` | `only if:` | Must be true for a run to act. Unknown is not true: nothing is done, and the run says why. |
| `then` | `do:` | What it does, step by step — when what started it has no steps of its own. |
| `otherwise` | `if a step fails:` | If a step does not succeed, or a person stops the run: each of these tried, whatever the others do. |

## What starts it — triggers

Each kind is described once, as data, in `src/kinds/triggers.ts` — its
words, what each holds, its sentence, its place in the editor, its examples
— and the checker, the file's reader and writer, the JSON Schema, the
editor and **[REFERENCE.md](REFERENCE.md)** are made from that. Lengths of
time are kept in seconds (`heldFor`, `every`), whatever a file writes.

| Data | Text | Starts a run |
|---|---|---|
| `at` | `at: "07:00"`, with `days: weekdays`, `weekends` or `[mon, fri]` | at a time of day on the automation's own clock — every day, or on those days |
| `every` | `every: 15 min` | every so many minutes from midnight (every 15 min is :00, :15, :30, :45); once a slot, never catching up |
| `event` | `event: mains.lost` with `from: station` | when the part filling a role raises an event its description declares |
| `becomes` | `becomes: station.charge < 15 %`, with `for: 2 min` | when a condition turns true — and, with `for` (`heldFor`), has stayed true that long; reads and comparisons only |
| `arrives` | `arrives: olof` with `at: work` — `arrives: someone`, `at: home` | when someone comes to a place, as presence says, as far as each shares: a role a person fills, any of a role people fill, or `someone`; at `home`, the automation's own, or a place a role names. The run knows who as `run.who` |
| `leaves` | `leaves: someone` with `at: home` | when someone leaves a place: the same `who` and `at` |
| `firstArrives` | `first arrives: home` — with `of: children` | when the first of the family — or of a role people fill — comes to a place none of them was at: a condition turning true (`edgeOf`), its state kept as `becomes`'s is |
| `lastLeaves` | `last leaves: home` — with `of: grownUps` | when the last of them leaves a place: nobody of them is there |
| `empties` | `empties: bathroom` with `for: 10 min` | when a place has nobody in it, whoever was there, by what stands in it — and, with `for`, has had nobody that long |
| `occupied` | `is occupied: hallway` — with `for: 5 min` | when a place has someone in it, whoever they are — and, with `for`, has had that long |
| `modeBecomes` | `mode becomes: away` — with `at: cabin` | when a home goes into a mode, by its key, whoever set it — the automation's own, unless `at` names another |
| `modeChanges` | `mode changes: day` — with `at: cabin` | when a home's mode on an axis — `presence` or `day` — changes, to whichever |
| `changes` | `changes: home.var.laundry` — with `from: washing`, `to: done`, `by at least: 50 W` | when a reading or a variable changes — to anything, or from one value, to another; a number only once it has moved that far. Its run knows `run.from` and `run.to`; what it last saw is kept across a restart |
| `onStart` | `on start: 1 min` | once each time kraftverk starts — after an update, a power cut — so long after (up to an hour) as its devices take to reconnect; not for an automation made or changed, and not rehearsed |

Any trigger may say what it does itself, under `do` (`then` in the data,
one of `TRIGGER_FIELDS`): a run it starts takes those steps in place of the
automation's own. So one automation does one thing when a level is crossed
one way and another the other way, each side with its own level and its own
hold, said where it is:

```text
when:
  - becomes: station.charge < 5 %
    for: 2 min
    do:
      - turn on: charger
  - becomes: station.charge >= 30 %
    for: 2 min
    do:
      - turn off: charger
```

A trigger without steps of its own takes the automation's. When several
share them and the steps must still tell them apart, a trigger may carry a
name, `id` (`id: low`) — letters and digits, starting with a lowercase
letter, unique within the rule — that the steps read back as
`run.trigger == "low"`.

Any automation can also be played by a person or started by another: that
is no trigger of its own. Played, it counts as started by the first of its
conditions that holds now — "do what you would do now", that trigger's steps
— and by none when none does: then it takes the automation's own steps, and
with none, it is not the time.

## What it does — steps

Each kind is described once, as data, in `src/kinds/steps.ts` — its fields,
what each holds, its words, its place in the editor, its examples, and for
a command and a setting the forms a file writes them in — and the checker,
the file's reader and writer, the JSON Schema, the editor's forms, the
engine's dispatch and **[REFERENCE.md](REFERENCE.md)** are made from that.
Lengths of time are in seconds, named as a file says them: `wait.for`,
`waitUntil.atMost`, `waitFor.atMost`, `ensure.within`, `watch.for`,
`start.andWait`.

| Data | Text | Does |
|---|---|---|
| `command` | `turn on: charger` · `turn off: charger` | switch a part (the `switch` capability's `set`) |
| `command` | `switch: charger` with `on: <condition>` | switch it on while the condition holds, off when it does not |
| `command` | `send: command` with `to: role`, `capability:` and `with: {…}` | any command a capability offers |
| `write` | `set: plug` with `setting: key` or `meaning: chargeLimit`, and `to: <value>` | change a setting the part offers, read back as any setting — never one its device declares dangerous |
| `wait` | `wait: 5 s` | a pause |
| `waitUntil` | `wait until: <condition>` with `at most: 2 min` | until the condition is true, or the run stops, not having succeeded |
| `waitFor` | `wait for: mains.restored` with `from: station` and `at most: 30 min` | until the part raises the event — one raised after it began to wait — or the run stops, not having succeeded |
| `ensure` | `make sure: <condition>` with `within: 20 s`, `tries: 5` and `each time: [steps]` | make sure it comes true within a time; if not, take the steps and look again, at most that many times — then the run stops, not having succeeded |
| `choose` | `if: <condition>` with `then: [steps]` and `else: [steps]` | one way or the other, as the condition is now; unknown is not true |
| `watch` | `watch: <condition>` with `for: 5 s`, `if it stays so: [steps]` and `if not: [steps]` | watch the condition for a while: the first steps if it stays true all that time, the others the moment it is not, or cannot be told |
| `repeat` | `repeat: 3` with `do: [steps]` — and `until: <condition>` | the steps, round after round: so many times — or until the condition is so after a round, at most that many, not succeeding if it never is. A round that does not succeed ends it |
| `forEach` | `for each: charger` with `in: chargers`, `do: [steps]` — and `together: true` | the steps for each part of a group, one after the other — or all at the same time — each called `charger` within them, as a role is. One that does not succeed: one after the other, the rest are not taken; together, the others go on to their end |
| `try` | `try: [steps]` with `if it fails: [steps]` | the steps; one that does not succeed is answered by the others — none, and it goes on as if it had. A stop is not caught |
| `stop` | `stop: Already charged` — and `failed: true` | the run ends here, saying why: as it went — or, failed, as not having succeeded, its `if a step fails` steps taken |
| `start` | `start: role` with `with: { level: 90 % }`, `and wait: 10 min`, `remember as: reached` | start the automation filling the role, as a person's play would, given its inputs — the rest their defaults; with a wait, until its run ends, and what it answered remembered. What it is given, and what it answers, are held to its `inputs` and `result` where the hub knows both (`checkStarted`) |
| `script` | `run script: role` with `step: tidyUp`, `with: { after: 10 min }`, `remember as: lastTidy` | run one of the steps of the script filling the role (docs/PLAN-SCRIPTS.md): a script in TypeScript, the family's, by key under `uses` (`{ script: key }`). It may read the home and act — through the gateway, as this automation — and wait, within its run; in watch mode it says what it would do. Its inputs and answer are held to what the script declares, where the hub has read it |
| `answer` | `answer: station.charge` | the run ends here, answering with a value of the kind its `result` says, in its unit: what a `start` that waited for it remembers, with `remember as` |
| `remember` | `remember: timesCharged` with `as: memory.timesCharged + 1` | remember a value for later steps and later runs: one of what the automation declares under `memory:`, converted to its unit and held to its range |
| `setMode` | `set mode: away` — with `at: cabin` | put a home in a mode, by its key — the automation's own, unless `at` names another — as a person would from its screen, on its timeline as the automation's |
| `setVariable` | `set variable: guests` with `to: true` — and `at: cabin` | set one of a home's variables (docs/PLAN-VARIABLES-AND-TRIGGERS.md) to a value of its kind, in its unit and range; read by every automation as `home.var.guests` |
| `count` | `count: dryerRuns` — `by: -1`, or `reset: true` | count one of a home's counters up by one, by so many, or back to its start |
| `notify` | `notify: everyone` with `title: …`, `text: …` and `level: warning` | tell a person, a role people fill, or `everyone`: their inbox, and a push to their phones; a value in braces said as it is then — `{station.charge}`, `{run.who}`. Said, not sent, in watch mode |

Every command and every setting goes through the gateway, under its rules,
and is audited as the automation's. A step that waits always has a limit,
every retry a count, every repeat at most `SEQUENCE_LIMITS.rounds` rounds —
and a run at most `SEQUENCE_LIMITS.steps` steps, its `if a step fails`
steps counted apart: whatever it repeats, every run ends.

## Conditions and values — expressions

Each kind is described once in `src/kinds/exprs.ts` — the expressions it
holds, how it is rebuilt with others in their place, its page in
**[REFERENCE.md](REFERENCE.md)** — so what walks an expression walks it by
these; what treats each kind its own way (the checker, the words, the text
form, the one evaluator) is a switch over every kind, which does not compile
with one left out. `evaluate` asks the functions an expression holds first —
the only part that waits — then evaluates it as `evaluateNow` does, with
their answers. A condition that is not so is said as its opposite
(`negation`): "the charge is at least 15 %", not "it is not so that the
charge is below 15 %".

| Data | Text | Is |
|---|---|---|
| `value` | `50 W`, `15 %`, `07:00`, `"text"`, `true` | a value; a number keeps the unit it is written in (`{ value: 50, unit: 'W' }`) — with none, it is in the unit of what it is compared with |
| `param` | `setting.cloudMax` | one of a recipe's settings |
| `memory` | `memory.timesCharged` | what it remembers, as a run last left it, in its unit, or before any did, as it starts |
| `variable` | `home.var.guests`, `cabin.var.guests` | one of a home's variables as it is now, of its own home or one a role fills: an automation that reads one looks again when it changes |
| `input` | `given.level` | one of its inputs, as the step that started the run gave it — or, not given, its default — in its unit. Read as `given.`, so a role may still be called `input` |
| `read` | `charger.power` | what the part filling a role reports now, by meaning (`charge`) or by its type's own (`acme.minutesToFull`) |
| `sun` | `sunset` · `30 min before sunset` · `time between sunset and sunrise` | when the sun rises or sets where the home is (`sunTimes`, sun.ts — the sunrise equation, to a minute), on the automation's clock — or so long before or after, a minute to 12 h, a number or a setting: a time of day, as `07:00` is, so `at: sunset` and `time between` take it. Unknown until the home has a place (`RuleScope.sun`), and on a day the sun does not cross the horizon |
| `across` | `any(c in chargers: c.power > 10 W)` · `all(…)` · `count(…)` · `sum(c in chargers: c.power ?? 0 W)` · `average(…)` · `lowest(…)` · `highest(…)` | something of each part of a group, taken together (`ACROSS_FNS`, kinds/across.ts): each part called by a name of its own within it, as a role is (`RuleScope.members`); numbers in the first one's unit. Unknown while it is for a part — unless one part settles it, one false for `all`, one true for `any`; `??` gives a part that may not say a value of its own. What is read of each is read of the group (`eachAsGroup`), so each part is held to it, and its readings move what waits on it |
| `history` | `average(station.charge, 1 h)` · `lowest(…)` · `highest(…)` · `change(…, 30 min)` · `ago(…, 10 min)` | a reading over the time just gone, from what the home kept (`RuleScope.history`, the engine's `EngineHistory` port): each value counted from when it was read until the next, the time a number or a setting from 1 min to 14 d, the answer in the reading's unit — unknown when nothing was kept. It reads what it looks back at, so it binds and re-evaluates as a reading does |
| `distance` | `distance(phone.position) < 500 m` · `distance(phone.position, car.position)` | how far the position a part reports (a `position` meaning, the `location` capability's) is from the home — or from another part's — over the Earth's surface, in m, compared in any length (`RuleScope.position`, `RuleScope.home`). Unknown when either position is, or the home has not said where it is. It reads the positions, so a part moving re-evaluates it |
| `call` | `acme.weather.sunny(forecast, day = "tomorrow")` | a function a package contributes, over the part filling a role: its whole id, then the role it reads and its arguments by name |
| `apply` | `min(a, b)`, `clamp(x, 0 W, 2 kW)`, `round(x, 1)` | one of the language's own functions (`src/kinds/builtins.ts`: min, max, clamp, round, floor, ceil, abs) — numbers in, a number in the first one's unit out |
| `script` | `feel.feelsLike(kitchen.temperature, kitchen.humidity)` | one of the functions of the script filling a role, its arguments in order (docs/PLAN-SCRIPTS.md): pure, so allowed wherever a condition is looked at, `becomes` too. Unknown when an argument is, or where no engine runs scripts; its arguments and answer held to what the script declares |
| `compare` | `a > b` | a comparison (below) |
| `in` | `station.mode in ["eco", "boost"]` | whether a value is one of a list (`item` and `in` in data) |
| `math` | `a + b`, `station.capacity * 50 %`, `charger.power * 2 h` | a number from two (below) |
| `negate` | `-meter.power` | a number's opposite |
| `if` | `price.priceRank <= 4 ? 2 kW : 500 W` | one value or the other, as a condition holds; unknown when it cannot be told |
| `either` | `outdoor.temperature ?? 10 °C` | the first of its values that is known |
| `all` | `a and b` | all true |
| `any` | `a or b` | any true |
| `not` | `not a` | not true |
| `reachable` | `charger reachable` | whether the part filling a role can be reached now: its holder says it is connected. Never unknown |
| `within` | `time between 23:00 and 05:00` | whether the owner's clock is between two times of day, from the first up to the second — across midnight when the second comes first |
| `presentAt` | `olof at home` · `not olof at work` · `any(p in children: p at school)` | whether a person is at a place now, as far as they share (`RuleScope.presentAt`): a role a person fills, or what an `across` over a role people fill calls each; `home`, the automation's own, or a role a place fills. A place's own facts are read as a reading is: `home.people` (how many of the family are there), `bathroom.occupied` (whether anyone is, whoever), `home.presence` and `home.day` (its mode on each axis, by key) |
| `run` | `run.trigger`, `run.event`, `run.event.voltage`, `run.who` | what the run knows of itself, as a value: `trigger`, the `id` of the trigger that started it — `""` when none with an id did; `event`, the event a device raised that started it — and, with a field, what it carried, as the device declares it: unknown when no event started it. Never in a trigger, where there is no run yet. The language's own namespace: a fact a run gains later is read the same way |

Comparisons (`compare`):

| Data | Text |
|---|---|
| `lt` | `<` |
| `le` | `<=` |
| `gt` | `>` |
| `ge` | `>=` |
| `eq` | `==` |
| `ne` | `!=` |

Arithmetic (`math`): `add` ` + `, `subtract` ` - `, `multiply` ` * `,
`divide` ` / `. Unknown when either side is, and a quotient by nothing. A
sum is in one unit; a product or quotient in the unit the two make
(`product`, `quotient` in units.ts): a power for a time is an energy
(`charger.power * 2 h`), an energy over a time a power, a percentage a share
of what it multiplies (`station.capacity * 50 %`), two of one dimension
divided a plain number. Any other pair makes no unit kraftverk knows, and
is a problem before it runs.

Precedence, loosest first: `c ? a : b`, `a ?? b`, `or`, `and`, `not`, a
comparison or `in [ … ]`, `+ -`, `* /`, `-x`, then a value, a reading,
`role reachable`, `run.trigger`, `setting.name`, `memory.name`, `time between … and …`, one
of the language's functions — `min(…)` — or a package's — `acme.weather.sunny(…)`
— or parentheses.

**Unknown.** A reading a device has not given, a part that cannot be reached,
a function that cannot tell: unknown, not false. A comparison with an unknown
side is unknown, and a condition that is unknown is not true — so a rule
never acts on what it cannot see.

## Units and lengths of time

- A unit is one of kraftverk's (`Unit`, `packages/device-sdk/src/units.ts`):
  an enumeration, never free text. Each says what it measures (its
  dimension) and how it converts; the parser refuses one it does not know
  where it is written, the checker one in data.
- A number keeps the unit it is written in — the data is
  `{ value: 2, unit: 'kW' }`, the file says `2 kW` again — and is
  converted where it meets another of its dimension: compared with a
  reading in W, it is 2000 W; written to a setting in W, 2000. One of
  another dimension is a problem before it runs: `50 °C` beside W, said by
  the checker for a standard meaning and by the binding for a part's own.
  A number with no unit is in the unit of what it is beside.
- Lengths of time are written with their unit — `5 s`, `2 min`, `1 h`,
  `1 d` — and read in seconds as a run waits. A bare `15` would be seconds
  to a wait and minutes to `every`, so it is refused. A setting used as a
  length of time is kept in seconds, as a run reads it.
- The app never asks for a unit as text: a number with a unit is a field
  and a choice among the units of its dimension.

## Roles

A role is filled by a part of a device that offers what the role needs
(`capabilities`), or — with `automation: true` — by another automation, for
`start`. The family's world fills three kinds more: a person
(`person: true`, `{ person: olof }` under `uses`), people — some, or
everyone, whoever joins (`people: true`, `{ people: [anna, ben] }`,
`{ people: everyone }`) — and a place (`place: true`, `{ home: cabin }`,
`{ zone: work }`, `{ space: bathroom }`, a space of the automation's own
home). `home` is the automation's own home without a role. What fills them
is `RoleFills.world`, by id. In the text form a role's label and needs come from what the rule
does with it (the commands it is sent, the standard readings read from it,
the events it raises); say them only when they differ:
`{ part: station.outlet.ac, label: …, needs: [switch, powerMeter] }`.

## Limits

Every sequence is held to these, whatever a rule asks (`SEQUENCE_LIMITS`):
the longest pause, watch or wait for a condition is an hour; one try of
`ensure` at most ten minutes; at most ten tries; steps within steps at most
four deep.

## How a rule is judged

The language says what a rule means; running it is the engine's
(`@kraftverk/automation-engine`). Two of its rules matter to anyone writing
one: once a run has switched something or changed a setting, a step that
judges readings judges only readings taken since — a station's reading from
before the change is not taken for the result of it; and a step that waits
asks the device for fresh readings until it is done.

## What a package contributes

A package brings recipes and functions as its own entry, beside its device
type:

```json
"kraftverk": { "deviceType": "./src/type.ts", "automation": "./src/automation.ts" }
```

```ts
import { defineContribution, defineFunction, defineRecipe } from '@kraftverk/automation';

export const skyLooks = defineFunction({ id: 'acme.weather.skyLooks', /* … */ });
export const forecastSwitch = defineRecipe({ id: 'acme.weather.forecast-switch', /* … */ });

export default defineContribution({ functions: [skyLooks], recipes: [forecastSwitch] });
```

- A **recipe** is a rule with its roles and settings left open, a label, a
  description and a sentence (`{role}` and `{setting}` in it); each role
  says what it is for whoever fills it (`RecipeRole`). Copying one makes an
  automation of the owner's own, whose roles keep their label and what they
  need — the description stays with the recipe.
- A **function** answers what a comparison cannot say — "does tomorrow look
  sunny" — with typed arguments and result, the capability it needs, and
  `null` with why when it cannot tell. It is handed a reader of the part
  (`DeviceReader`: readings, health, and queries answered in their declared
  types, `ask`) and nothing that can command or write.
- Ids are namespaced by the package's device type. `checkContribution`
  checks a contribution when it is installed: every recipe as a rule against
  the functions it brings; the rest once everything is installed.

The **standard recipes** (`STANDARD_RECIPES`, namespaced `standard.`) name
only library capabilities, standard meanings and the events capabilities
declare, so every device that offers them fills their roles: when a battery
runs low, charge between two levels, when the mains is lost, start and stop
charging, the cheapest hours of the day.

## The API

| | |
|---|---|
| The rule | `Rule`, `Trigger`, `Step`, `Expr`, `RoleSpec`, `Recipe`, `AutomationFunction` |
| Checking | `checkRule(rule, vocabulary)` — what is wrong, in words; `checkBinding` — whether what fills its roles fits; `problemPlace` |
| Saying it | `describeRule`, `describeTriggers`, `describeSteps`, `describeExpr` — the sentences the app shows |
| Evaluating | `evaluate`, `evaluateNow`, `settledChoice` — what a condition is now; `calculate`; `ask` |
| What it uses | `ruleUses`, `ruleCommands`, `roleEvents`, `readsRole`, `changedRoles`, `takesSteps` |
| Editing | `listAt`, `withList`, `withStep`, `insertStep`, `removeStep`, `moveStep`, `within`, `depthOf`, `kindsFor`, `mayWait`, `usedRoles` — each edit a new rule |
| Recipes | `defineRecipe`, `inlineParams`, `STANDARD_RECIPES` |
| Contributions | `defineContribution`, `defineFunction`, `checkContribution` |
| The text form | `ruleFromConfig`, `ruleToConfig`, `parseExpr`, `printExpr`, `durationSeconds`, `durationText` |
