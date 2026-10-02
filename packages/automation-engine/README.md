# @kraftverk/automation-engine — runs automations

The engine that runs what `@kraftverk/automation` describes: it starts runs
from triggers (a time, every so many minutes, an event, a condition that
becomes true), takes their steps, records each run and what devices said
while it ran, and rehearses a rule against what devices said before. It
keeps the library of recipes and functions the installed packages bring.

Pure, so the server and the app run it alike. It names no database and no
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
