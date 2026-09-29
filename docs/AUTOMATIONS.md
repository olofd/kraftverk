# Automations: one language, written by packages, people, a DSL or an AI

**Status:** the design behind docs/ARCHITECTURE.md step 29, and *built*
(2026-09-29) as far as "Where this goes": the rule and its checker, evaluator
and sentences (`packages/device-sdk/src/automation.ts`), recipes and
functions from packages, events from the station, and one engine with all
three triggers. The last section is the direction the contract is shaped for,
not a promise of when.

## The problem with recipes as code

The first automation, "switch by the forecast", was a function: it read the
forecast, averaged the clouds, and returned "turn it on". That works for one
recipe written by us. It does not work for what kraftverk wants automations
to become:

- **Decentralised.** Every package should bring what its device makes
  possible: the station knows what "mains lost" means, the weather service
  knows what "a sunny day" means. The core should know neither.
- **Programmable by a DSL.** A few lines of text — *when the station's battery
  stays below 20 % for 5 minutes, turn the heater plug on* — should become an
  automation.
- **Written by an AI, in the app.** You say what you want; the app proposes an
  automation; you see in one sentence what it will do, watch it observe, and
  arm it.

A function can be filled in (roles, settings) but not composed, checked,
explained or generated. So an automation is **data**, in one small typed
language — the *rule* — and code only exists where data cannot reach: in
**functions** a package contributes.

## The rule

```ts
type Rule = {
  roles:  Record<string, RoleSpec>;   // what each part it works with must offer
  params: ConfigSchema;               // its settings, in the one value system
  when:   Trigger[];                  // any of these starts a run
  if?:    Expr;                       // must be true; unknown means "do nothing, and say why"
  then:   Action[];                   // through the gateway, like any command
};

type Trigger =
  | { at: Expr }                                   // every day at "07:00", on the owner's clock
  | { event: { role: string; event: string } }     // something a device said happened
  | { becomes: Expr; heldForMinutes?: Expr };      // a condition turning true, and staying true

type Expr =
  | { value: Value }                               // a literal
  | { param: string }                              // one of its settings
  | { read: { role: string; means: string } }      // a part's current value, by meaning
  | { call: string; role: string; args?: Record<string, Expr> }  // a package's function
  | { compare: 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne'; left: Expr; right: Expr }
  | { all: Expr[] } | { any: Expr[] } | { not: Expr };

type Action =
  | { command: { role: string; capability: CapabilityName; command: string; args: Record<string, Expr> } };
```

Every name in a rule is one the device model already has: roles ask for
**capabilities**, values are read by **meaning** (`battery.soc`, or a type's
own `p280.minutesToFull`), triggers name **events** a description declares,
actions are **commands** a capability declares, with typed arguments. The rule
adds no vocabulary of its own; it composes the model's.

What that buys:

- **Checked before it runs.** `checkRule` type-checks a rule against the
  capability library and the installed functions — a comparison of a
  percentage with a boolean, a command a capability does not have, a function
  given a role that cannot answer it — and says where, as a path:
  `then[0].command.args.on: expected a boolean, got a number`. When it is
  bound to your devices, `checkBinding` checks each part offers what its role
  needs, reports each meaning read, and declares each event triggered on.
  These messages are what a person reads in the editor and what an AI is fed
  back until its rule checks.
- **Three-valued.** Every expression evaluates to a value or to *unknown*
  (`null`): a device that is offline, a forecast that does not reach
  tomorrow. Unknown is never false and never true; a run whose condition is
  unknown does nothing and says why. That is the rule the recipe had, now
  for every automation.
- **Explained.** A run keeps a trace: which trigger fired, each value it read
  and each function's answer, in words — "tomorrow looks cloudy: 55 % cloud
  between 09:00 and 17:00". A rule has a sentence, from its recipe's own
  wording or generated from the rule.
- **Safe by construction.** A rule can only read, compare and ask the gateway
  for commands. It cannot run code, reach the network, or skip the gateway's
  dwell, freshness, confirmation, read-only mode or verification. Whatever
  writes a rule — a package, a person, a DSL, an AI — writes data, and the
  worst a wrong rule can do is what a person could do from a screen, after it
  has been watched observing and armed on purpose.

## What a package contributes

A device type's package may bring, beside its description:

- **Events** in its description — `mains.lost` on the station's mains input —
  raised by its session with `ctx.event`. Triggers name them.
- **Functions**: named, typed computations a rule can call, for what a
  comparison cannot say. The weather service's `open-meteo.weather.skyLooks` asks any
  part offering `weather.forecast` for the day's hours and answers `sunny` or
  `cloudy`, with the reason. A function declares the capability it needs, its
  arguments and its result in the value system, and is the only place an
  automation runs package code. It is generic over the capability, not over
  its own device: another package's forecast answers it too.
- **Recipes**: rules with roles and settings left open, a label and a
  sentence — the weather service's "Switch by the forecast", the station's
  "When the battery runs low" and "When mains power is lost". A recipe is
  data; filling it in makes an automation.

All three are namespaced by the type (`open-meteo.weather.forecast-switch`) and found
the way device types are — installing a package is all it takes, and the core
holds no recipe of its own. A recipe may use any installed package's
functions; one whose function is missing is refused at start, saying which.

## One engine

The server's engine runs every automation the same way:

- **`at`**: looked at every half minute; due once a day at that time, on the
  owner's clock, up to an hour late (a server that was down at 07:00 still
  acts at 07:20).
- **`event`**: heard on the live bus as the device raises it.
- **`becomes`**: evaluated when a reading of a bound device moves, again from
  the live bus. It fires on the change from not-true to true, and with
  `heldForMinutes` only once it has stayed true that long. It may only read and
  compare — no function calls — so it is cheap to evaluate on every reading.
  A condition that is already true when the server starts is a starting
  point, not a change.

A run evaluates `if`, then each action: an automation that **observes** says
what it would have done; one **armed** sends it through the gateway as
`actor: 'automation'`. Every run is on the timeline with its trace. The modes,
arming with confirmation and "check now" are unchanged.

## Stored

An automation is its recipe's id, which part of which device fills each role,
its settings, its clock and its mode — the same columns as before. The rule is
the recipe's, resolved when it runs, so a package that improves a recipe
improves every automation made from it.

## Where this goes (not built)

- **Rules of your own.** An automation that carries its rule instead of a
  recipe id — one column, `rule`, JSON. The engine already runs rules, not
  recipes; a recipe is only where the rule comes from.
- **A DSL.** A text syntax whose parse tree *is* the rule: `when station.battery
  < 20 % for 5 min then turn heater on`. Parsing is the only new part; checking,
  explaining and running are done.
- **AI in the app.** The model is given the vocabulary — your devices, their
  parts, the meanings each reports, the events each raises, the commands each
  takes, the installed functions and recipes (one endpoint, generated from the
  descriptions) — and asked for a rule or DSL text. `checkRule` and
  `checkBinding` are its critic; the sentence is what you approve; it starts
  observing, as every automation does. The AI writes data inside the same
  rails as everything else.
- **More in the language, as needs arrive:** writing a setting (through the
  gateway's write path, never a dangerous one), notifications, a wait
  between actions, schedules on some days only, sunrise and sunset from a
  weather or location function, arithmetic over readings.
- **Automations in the app**, for devices only a phone holds: the evaluator
  is pure SDK code, like the gateway, and can run in either holder.
