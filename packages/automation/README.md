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
| `roles` | `uses:` | What it works on, by role: a part of a device that offers some capabilities, or another automation. Filled when the rule becomes an automation. |
| `params` | — | A recipe's settings, read as `$name`. An automation of its own has them written into its blocks (`inlineParams`). |
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
`waitUntil.atMost`, `ensure.within`, `watch.for`, `start.andWait`.

| Data | Text | Does |
|---|---|---|
| `command` | `turn on: charger` · `turn off: charger` | switch a part (the `switch` capability's `set`) |
| `command` | `switch: charger` with `on: <condition>` | switch it on while the condition holds, off when it does not |
| `command` | `send: command` with `to: role`, `capability:` and `with: {…}` | any command a capability offers |
| `write` | `set: plug` with `setting: key` or `meaning: chargeLimit`, and `to: <value>` | change a setting the part offers, read back as any setting — never one its device declares dangerous |
| `wait` | `wait: 5 s` | a pause |
| `waitUntil` | `wait until: <condition>` with `at most: 2 min` | until the condition is true, or the run stops, not having succeeded |
| `ensure` | `make sure: <condition>` with `within: 20 s`, `tries: 5` and `each time: [steps]` | make sure it comes true within a time; if not, take the steps and look again, at most that many times — then the run stops, not having succeeded |
| `choose` | `if: <condition>` with `then: [steps]` and `else: [steps]` | one way or the other, as the condition is now; unknown is not true |
| `watch` | `watch: <condition>` with `for: 5 s`, `if it stays so: [steps]` and `if not: [steps]` | watch the condition for a while: the first steps if it stays true all that time, the others the moment it is not, or cannot be told |
| `start` | `start: role` with `and wait: 10 min` | start the automation filling the role, as a person's play would; with a wait, until its run ends |

Every command and every setting goes through the gateway, under its rules,
and is audited as the automation's. A step that waits always has a limit,
and every retry a count.

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
| `value` | `50 W`, `15 %`, `07:00`, `"text"`, `true` | a value; a number in the unit of what it is compared with |
| `param` | `$cloudMax` | one of a recipe's settings |
| `read` | `charger.power` | what the part filling a role reports now, by meaning (`charge`) or by its type's own (`acme.minutesToFull`) |
| `call` | `call open-meteo.weather.skyLooks(forecast, cloudMax = 40)` | a function a package contributes, over the part filling a role |
| `compare` | `a > b` | a comparison (below) |
| `math` | `a + b`, `min(a, b)` | a number from two (below), in one unit |
| `all` | `a and b` | all true |
| `any` | `a or b` | any true |
| `not` | `not a` | not true |
| `reachable` | `charger reachable` | whether the part filling a role can be reached now: its holder says it is connected. Never unknown |
| `within` | `time between 23:00 and 05:00` | whether the owner's clock is between two times of day, from the first up to the second — across midnight when the second comes first |
| `run` | `run.trigger` | what the run knows of itself, as a value: `trigger`, the `id` of the trigger that started it — one of its triggers' ids, so comparing it with any other is a problem. `""` when none with an id did — known, not unknown; not in a trigger, where there is no run yet. The language's own namespace: a fact a run gains later is read the same way |

Comparisons (`compare`):

| Data | Text |
|---|---|
| `lt` | `<` |
| `le` | `<=` |
| `gt` | `>` |
| `ge` | `>=` |
| `eq` | `==` |
| `ne` | `!=` |

Arithmetic (`math`): `add` `+`, `subtract` `-`, `min` `min( , )`, `max`
`max( , )`. Unknown when either side is.

Precedence, loosest first: `or`, `and`, `not`, a comparison, `+ -`, then a
value, a reading, `role reachable`, `run.trigger`, `time between … and …`, `min( , )`,
`max( , )`, `call …`, `$setting`, or parentheses.

**Unknown.** A reading a device has not given, a part that cannot be reached,
a function that cannot tell: unknown, not false. A comparison with an unknown
side is unknown, and a condition that is unknown is not true — so a rule
never acts on what it cannot see.

## Units and lengths of time

- A number beside a reading is in that reading's unit — its standard
  meaning's (`power` is in W), or the part's own. One written in another
  unit of the same quantity is converted (`2 kW` beside a reading in W is
  2000); one of another quantity is a problem (`50 °C` beside W).
- Lengths of time are written with their unit — `5 s`, `2 min`, `1 h`. A
  bare `15` would be seconds to a wait and minutes to `every`, so it is
  refused.

## Roles

A role is filled by a part of a device that offers what the role needs
(`capabilities`), or — with `automation: true` — by another automation, for
`start`. In the text form a role's label and needs come from what the rule
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
