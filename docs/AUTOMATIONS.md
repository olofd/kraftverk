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
  has been watched observing and armed on purpose. A value it reads is what
  the part reports *now*: one older than its attribute says a value stays
  current (`currentFor`) is unknown, as it is to history and the gateway.

### Kept closed, on purpose

The language grows, but only by what passes two tests:

1. **`describeRule` can still say it in one sentence.** A person approves an
   automation by reading it; a construct that cannot be read back is one
   nobody can approve.
2. **`checkRule` can still type it without running it.** The checker is what a
   DSL's errors and an AI's critic are made of; a construct it cannot check
   is one an AI can get wrong without anyone knowing until it runs.

What fails either belongs in a package **function** — typed at its edges,
answering, never acting — not in the language. Arithmetic over readings,
waits between actions, notifications and schedules on some days are
candidates; each goes in only when it passes both, and one at a time. That
discipline is what keeps "an AI writes data inside the same rails" true.

## What a package contributes

A device type's package may bring, beside its description:

- **Events** in its description — `mains.lost` on the station's mains input —
  raised by its session with `ctx.event`. Triggers name them.
- **Functions**: named, typed computations a rule can call, for what a
  comparison cannot say. The weather service's `open-meteo.weather.skyLooks`
  asks any part offering `weather.forecast` for the day's hours and answers
  `sunny` or `cloudy`, with the reason. A function declares the capability
  it needs, its arguments and its result in the value system, and is the only
  place an automation runs package code. It is generic over the capability,
  not over its own device: another package's forecast answers it too. It is
  handed a **reader** of the part — its readings, its health, and its queries
  answered in the type the capability declares (`ask(part, 'weather.forecast',
  'hourly', …)` is a checked forecast, no cast) — and nothing that can command,
  write or run a tool: "answers, never acts" is the contract's, not a
  convention.
- **Recipes**: rules with roles and settings left open, a label and a
  sentence, for what only its devices make possible — the weather service's
  "Switch by the forecast", which needs its function. A recipe is data;
  filling it in makes an automation.

Package ids are namespaced by the type (`open-meteo.weather.forecast-switch`)
and found the way device types are — installing a package is all it takes.

**The shared vocabulary's recipes** sit beside the capability library
(`device-sdk/src/recipes.ts`), namespaced `standard.`: rules that name only
library capabilities, standard meanings and the events capabilities declare,
so every device that offers them fills their roles and a home without any one
product still gets them.

- **When a battery runs low** — below a level for a while, switch something.
- **Charge between two levels** — switch what charges a battery on when it
  stays below a low level, off when it reaches a high one. A station fed by a
  smart plug gets a charge window of its own this way: on below 15 %, off at
  50 %, beneath the lowest AC charge limit the station's own settings allow.
  One rule with two `becomes` edges; its command sets the charger to "below
  the high level?", so falling low turns it on, reaching high turns it off,
  and nothing clicks in between.
- **When mains power is lost** — on `acInput`'s own `mains.lost`, from any
  station that raises it.

A recipe may use any installed package's functions; one whose function is
missing is refused at start, saying which.

## One engine

The server's engine runs every automation the same way:

- **`at`**: looked at every half minute; due once a day at that time, on the
  owner's clock, up to an hour late (a server that was down at 07:00 still
  acts at 07:20).
- **`event`**: heard on the live bus as the device raises it.
- **`becomes`**: evaluated when a reading of a bound device moves, from the
  live bus, and on the half-minute clock besides — a battery sitting at 8 %
  sends nothing. It fires on the change from not-true to true, and with
  `heldForMinutes` only once it has stayed true that long. It may only read
  and compare — no function calls — so it is cheap to evaluate on every
  reading. Each trigger's state — what its condition was last, since when it
  has held, whether this hold has run — is kept in the database, so a restart
  continues from where it was: nothing fires twice, a hold resumes with the
  time it had left, and a condition that turned true while the server was
  down fires when it is back. A trigger with nothing kept — an automation
  just made, or changed, or armed — takes a condition already true as its
  edge: a charge window armed at 8 % starts charging, rather than waiting
  for the battery to rise and fall again, which nothing would make it do.
  Only the automations bound to a device are looked at when it reports.

A run evaluates `if`, then each action: an automation that **observes** says
what it would have done; one **armed** sends it through the gateway as
`actor: 'automation'`. Every run is on the timeline with its trace. Arming is
confirmed with a token bound to the automation, its changes and the person.

**Rehearsal** walks a rule through a window of history — the minute samples
of everything it reads, the events it waits for, its times of day — with the
engine's own trigger rules, including a hold that runs its time with no new
sample, and says at each run what it would have decided and done
(`server/src/automations/rehearse.ts`). Nothing is sent. It says what it
cannot see: history is what happened *without* it (a charger it would have
switched on would have raised the charge), and a function that asks for
something history does not keep — a forecast — is unknown, as it would be
with the service away. In the app, "Rehearse on last week" beside "Check
now"; for an assistant, the `rehearse` and `propose` tools.

## Stored

An automation is its recipe's id (`standard.charge-between`,
`open-meteo.weather.forecast-switch`), which part of which device fills each
role, its settings, its clock and its mode. The rule is
the recipe's, resolved when it runs, so a package that improves a recipe
improves every automation made from it.

## Where this goes (not built)

- **Rules of your own.** An automation that carries its rule instead of a
  recipe id — one column, `rule`, JSON. The engine already runs rules, not
  recipes; a recipe is only where the rule comes from.
- **A DSL.** A text syntax whose parse tree *is* the rule: `when station.battery
  < 20 % for 5 min then turn heater on`. Parsing is the only new part; checking,
  explaining and running are done.
- **AI in the app.** The minimum is built: `GET /world`, `GET /vocabulary`
  and an MCP endpoint whose `propose` makes an automation from a recipe,
  observing, rehearsed ([API.md](API.md)). Next, a model asked for a rule or
  DSL text of its own, with `checkRule` and `checkBinding` its critic and the
  sentence what you approve — inside the same rails as everything else.
- **More in the language, as needs arrive:** writing a setting (through the
  gateway's write path, never a dangerous one), notifications, a wait
  between actions, schedules on some days only, sunrise and sunset from a
  weather or location function, arithmetic over readings.
- **Automations in the app**, for devices only a phone holds: the evaluator
  is pure SDK code, like the gateway, and can run in either holder.
