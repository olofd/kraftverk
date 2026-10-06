# Automations: one language, written by packages, people, a DSL or an AI

**Status:** the design behind docs/ARCHITECTURE.md step 29, and *built*
(2026-09-29) as far as "Where this goes": the rule and its checker, evaluator
and sentences (`@kraftverk/automation`, `packages/automation`), recipes and
functions from packages, events from the station, and one engine with all
three triggers. The last section is the direction the contract is shaped for,
not a promise of when. **Sequences** — steps that wait, make sure, choose and
watch — are [SEQUENCES.md](SEQUENCES.md), built 2026-09-30 on the same
language and engine. Since then **every automation owns its rule**, built
block by block in the app's editor or copied from a recipe, and any of them
can be started by hand, change a setting, or start another
([AUTOMATION-EDITOR.md](AUTOMATION-EDITOR.md)).

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
  automation; you see in one sentence what it will do, watch what it would
  do, and let it act.

A function can be filled in (roles, settings) but not composed, checked,
explained or generated. So an automation is **data**, in one small typed
language — the *rule* — and code only exists where data cannot reach: in
**functions** a package contributes.

## The rule

```ts
type Rule = {
  roles:  Record<string, RoleSpec>;   // what each part it works with must offer
  params: ConfigSchema;               // a recipe's settings; an automation's are empty — its values are in its blocks
  when:   RuleTrigger[];              // any of these starts a run on its own; none, and it runs when started
  if?:    Expr;                       // must be true; unknown means "do nothing, and say why"
  then:   Step[];                     // in order: commands, and — a sequence — waits, choices (SEQUENCES.md);
                                      // what a run does when what started it has no steps of its own
  otherwise?: Step[];                 // if a step does not succeed, or it is stopped
};

type Trigger =
  | { at: Expr; days?: Weekday[] }                 // at "07:00" on the owner's clock, every day or on these
  | { every: Expr }                                // every so many minutes, on the clock from midnight
  | { event: { role: string; event: string } }     // something a device said happened
  | { becomes: Expr; heldFor?: Expr };      // a condition turning true, and staying true

type RuleTrigger = Trigger & {
  then?: Step[];                                   // what a run it starts does, in place of the rule's
  id?: string;                                     // a name shared steps read back as run.trigger
};

type Expr =
  | { value: Value }                               // a literal
  | { param: string }                              // one of its settings
  | { read: { role: string; means: string } }      // a part's current value, by meaning
  | { call: string; role: string; args?: Record<string, Expr> }  // a package's function
  | { compare: 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'ne'; left: Expr; right: Expr }
  | { math: 'add' | 'subtract' | 'min' | 'max'; left: Expr; right: Expr }   // numbers, in one unit
  | { all: Expr[] } | { any: Expr[] } | { not: Expr }
  | { reachable: string }                          // the part filling a role can be reached now
  | { within: { from: Expr; to: Expr } };          // the owner's clock is between two times, "22:00" to "06:00" across midnight

type Step =
  | { command: { role: string; capability: CapabilityName; command: string; args: Record<string, Expr> } }
  | { write: { role: string; key: string; value: Expr } }          // a setting the part keeps, by its key
  | { write: { role: string; means: string; value: Expr } }        //   or by a standard meaning, which a recipe can name
  | { start: { role: string; andWait?: Expr } }                // another automation, waited for or not
  | { wait } | { waitUntil } | { ensure } | { choose } | { watch };   // SEQUENCES.md
```

A role is a part — `{ label, capabilities }` — or another automation,
`{ label, automation: true }`, filled by one of the owner's own. A recipe's
roles also say what each is for, for whoever fills them (`description`),
which an automation made from it leaves with the recipe.

Every name in a rule is one the device model already has: roles ask for
**capabilities**, values are read by **meaning** (`charge`, or a type's
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
  has been seen watching and let act on purpose. A value it reads is what
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
answering, never acting — not in the language. Waits between actions went
in that way — six kinds of step, each bounded, each read back as a line of a
numbered list (SEQUENCES.md) — and so did changing a setting, starting
another automation, and days of the week (AUTOMATION-EDITOR.md), and then a
window of the day and arithmetic — sums, differences, the lower or higher of
two numbers, units checked as a comparison checks them. Notifications are a
candidate; each goes in only when it passes both, and one at a time. That discipline is what keeps "an AI writes data
inside the same rails" true.

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
  "Switch by the forecast", which needs its function. A recipe is data, and
  a starting point: copying it makes an automation of your own, its
  settings written into its blocks (`inlineParams`), every step then yours
  to change.

Package ids are namespaced by the type (`open-meteo.weather.forecast-switch`)
and found the way device types are — installing a package is all it takes: a
package's `kraftverk.automation` entry, beside its `deviceType`, exports
`defineContribution({ recipes, functions })`.

**The shared vocabulary's recipes** sit beside the capability library
(`packages/automation/src/recipes.ts`), namespaced `standard.`: rules that name only
library capabilities, standard meanings and the events capabilities declare,
so every device that offers them fills their roles and a home without any one
product still gets them.

- **When a battery runs low** — below a level for a while, switch something.
- **Charge between two levels** — switch what charges a battery on when it
  stays below a low level, off when it reaches a high one. A station fed by a
  smart plug gets a charge window of its own this way: on below 15 %, off at
  50 %, beneath the lowest AC charge limit the station's own settings allow.
  One rule with two `becomes` edges, each with what it does beside it:
  falling low turns the charger on, reaching high turns it off, and nothing
  clicks in between.
- **When mains power is lost** — on `acInput`'s own `mains.lost`, from any
  station that raises it.
- **In the cheapest hours** — switch something on in the day's cheapest
  hours by the electricity price (`priceRank`, from any part offering
  `energyPrice`), off in the others.

A recipe may use any installed package's functions; one whose function is
missing is refused at start, saying which.

## One engine

The server's engine runs every automation the same way:

- **`at`**: looked at every half minute; due once a day at that time, on the
  owner's clock and on the days it names (`days`, none for every day), up to
  an hour late (a server that was down at 07:00 still
  acts at 07:20).
- **`every`**: looked at every half minute; due once in each slot of so many
  minutes on the owner's clock, counted from midnight (every 15: :00, :15,
  :30, :45). A server that was down runs once, at the latest slot, and does
  not catch up.
- **`event`**: heard on the live bus as the device raises it.
- **`becomes`**: evaluated when a reading of a bound device moves, from the
  live bus, and on the half-minute clock besides — a battery sitting at 8 %
  sends nothing. It fires on the change from not-true to true, and with
  `heldFor` (more than 0, at most a week) only once it has stayed
  true that long. Turned true while a run of it still takes its steps, it
  runs again once that run ends, if it still holds. It may only read
  and compare — no function calls — so it is cheap to evaluate on every
  reading. Each trigger's state — what its condition was last, since when it
  has held, whether this hold has run — is kept in the database, so a restart
  continues from where it was: nothing fires twice, a hold resumes with the
  time it had left, and a condition that turned true while the server was
  down fires when it is back. A trigger with nothing kept — an automation
  just made, or changed, or let act — takes a condition already true as its
  edge: a charge window let act at 8 % starts charging, rather than waiting
  for the battery to rise and fall again, which nothing would make it do.
  Only the automations bound to a device are looked at when it reports.

A condition fires once: what the automation did then stays until a condition
turns true again, and a person may change it in between. An automation can
instead **keep things so** (`recheckMinutes`, chosen when it is set up: off,
5, 10, 30 or 60 minutes). On that schedule — counted from its last look, its
last run or its last change, and kept across restarts — a `becomes`
condition that still holds, and has held as long as it must, runs it again,
with the reason "Checked again, every 10 min: …". Nothing is sent, and
nothing recorded, when every attribute its commands set (as the capability
declares `sets`) already reads what it would be set to. The owner's charge
window: switched off at 74 %, switched back on by hand, it is off again at
the next look. Between the two levels no condition holds, and nothing is
changed: the window stays a window. What another automation set since it
last acted is left — the last edge wins, and the two do not undo each other
at every look; what a person or an assistant changed is switched back. A
setting it changes is kept so as a command is. Time-of-day and event
triggers have nothing to keep. The gateway's dwell still applies to every run, and turning
it on for an automation that acts is confirmed as letting it act is.

A run evaluates `if`, then each action: an automation set to **watch** says
what it would have done; one set to **act** sends it through the gateway as
`actor: 'automation'`. Letting it act is confirmed with a token bound to the
automation, its changes and the person. The mode governs only what it does
**on its own**: started by a person — ▶ on its card, on the device it is
about, or on the home page — any automation that is not off runs and acts,
asked first in the app while it only watches. An assistant may start only
one that acts; another automation's `start` step, only one that is not off
(SEQUENCES.md).

**A run explains itself.** Each is kept — on the automation as its last run,
and on the timeline — with what started it (`why`: "Garage station's charge is
at least 50 %", "Every day at 07:00", "Looked again after 10 min, and it still
holds: …"), what it read (`saw`), how each condition stood (`conditions`) and
what it did (`actions`, each done, already so, refused, failed, unverified, or
not sent while it only watches), with a one-line `summary`. The app's card
shows how each condition stands **now**, with the readings it stands on and
when it next looks again; its last run; what it would do now; and its history,
day by day, each run opening to what it read and did, each change saying who
made it and what changed ("Only watching → Acting", "Keep it so: off → every
10 min").

**Automations take turns with a part.** A run holds every part it may
change while it runs — with the runs of its own chain — and another
automation's run that needs one is refused, not queued, and says which and
whose; people and assistants are never held. Each automation's card says
which others change the same parts (`sharedWith`). And the gateway keeps the
home's **reserve**: below `reserveSoc`, switching on what drains a station's
battery is refused to an automation (docs/SHARED-PARTS-AND-RESERVE.md).

A change to what an automation watches, or to whether it may act, starts its
conditions afresh and looks at them at once: let act while one already
holds, it acts then, not at the next reading. A new name, or how often it
keeps things so, changes neither, and what it did stands.

The app asks for every yes in a dialog of its own, not the browser's
`confirm`, which some browsers answer no to at once, showing nothing.

**Rehearsal** walks a rule through a window of history — the minute samples
of everything it reads, the events it waits for, its times of day — with the
engine's own trigger rules, including a hold that runs its time with no new
sample, and says at each run what it would have decided and done
(`packages/automation-engine/src/rehearse.ts`). Nothing is sent. It says what it
cannot see: history is what happened *without* it (a charger it would have
switched on would have raised the charge), and a function that asks for
something history does not keep — a forecast — is unknown, as it would be
with the service away. In the app, "Rehearse last week" beside "What would
it do now?"; for an assistant, the `rehearse` and `propose` tools.

## Stored

An automation is its own rule (`rule`, JSON), the recipe it was copied from
if it was (`made_from`, shown as "Made from …" and nothing more), which part
of which device — or which other automation — fills each role
(`automation_role`), its clock, its mode, and its place on the home page if
it has one. A recipe improved later changes no automation copied from it:
what runs is what its owner saw and approved. Each `becomes` trigger's state
is a row (`automation_trigger`), and every run is one (`automation_run`) —
the running one unended, one at a time, and the run that started it if
another did (`started_by_run`) — with each step it took (docs/DATA-MODEL.md,
docs/SEQUENCES.md).

## Where this goes (not built)

- **A DSL.** A text syntax whose parse tree *is* the rule: `when station.battery
  < 20 % for 5 min then turn heater on`. Parsing is the only new part; checking,
  explaining and running are done.
- **AI in the app.** The minimum is built: `GET /world`, `GET /vocabulary`
  and an MCP endpoint whose `propose` makes an automation from a recipe,
  watching, rehearsed ([API.md](API.md)). Next, a model asked for a rule or
  DSL text of its own, with `checkRule` and `checkBinding` its critic and the
  sentence what you approve — inside the same rails as everything else.
- **More in the language, as needs arrive:** notifications, sunrise and
  sunset from a weather or location function.
- **Automations in the app**, for devices only a phone holds: the evaluator
  is pure SDK code, like the gateway, and can run in either holder.
