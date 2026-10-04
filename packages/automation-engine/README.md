# @kraftverk/automation-engine — runs automations

## What it is

The engine that runs what `@kraftverk/automation` describes: it starts runs
from triggers (a time, every so many minutes, an event, a condition that
becomes true), takes their steps, records each run and what devices said
while it ran, and rehearses a rule against what devices said before. It
keeps the library of recipes and functions the installed packages bring.

## What it does — and does not

- **Does:** run automations — their triggers, their steps, a person's play
  and stop — and judge each step on readings taken since the run last
  changed something; tell each run which trigger started it (`run.trigger`);
  keep every run and its log through its storage port; rehearse; gather the
  installed contributions into a library. Its ticks, holds, pauses and
  stamps keep the clock it is given — the home's, or a test's.
- **Does not:** keep anything itself (`AutomationStorage` is a port the
  store fills), reach a device but through `EngineDevice`, or send a
  command but through the gateway. It names no database and no product.

## Where it fits

The runtime layer (docs/PLAN-SHARED-CORE.md): above the language, the
gateway, the API's shapes and the holder; under the store, which keeps its
records, and the hub, which wires it to a home's devices.

## Why a package of its own

Because automations run wherever a home is held — on the server, and in an
app with no server (decision 4). Pure and on its own, the engine is the
same there as here, and a device package declaring recipes needs only the
language, not this.

## In detail

Pure, so every node runs it alike. It names no database and no
device:

- **Where automations are kept** is a port it declares,
  `AutomationStorage` (`src/storage.ts`): the automations, what their
  triggers last saw, every run and its log. The store keeps them in SQLite,
  on the server and in the app.
- **Devices** it reaches through `EngineDevice`: a part filling a role, its
  description, a reader for its readings and queries, whether it can be
  reached, and a way to ask it for fresh readings while a step waits.
- **Every command and setting** goes through the gateway
  (`@kraftverk/gateway`), audited as the automation's.

| | |
|---|---|
| `AutomationEngine` | runs automations: their triggers, their steps, a person's play and stop |
| `AutomationStorage`, `TriggerState` | the port where automations and runs are kept |
| `AutomationLibrary`, `Contributed` | the recipes and functions installed packages bring, each checked against the rest |
| `rehearse` | a rule tried against what devices said, sending nothing |
| `runLogCsv`; `seriesOf`, `marksOf`, `windowOf` | a run's log as a file, and as the series and marks its page draws |

How a step judges readings — only those taken since the run last changed
something — and the limits every sequence keeps are the language's to say:
`@kraftverk/automation`'s README.
