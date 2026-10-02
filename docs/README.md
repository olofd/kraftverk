# The documents

Which of these say how kraftverk is now, and which are kept as they were
written. [AGENTS.md](../AGENTS.md) is where to start;
[ARCHITECTURE.md](ARCHITECTURE.md) is the authority.

A current document names only what is there: every repository path in it,
and every file it links to, exists (`npm run check:architecture`). A plan or
a record keeps the paths of its day, and is read as history. Every document
here is in one list or the other.

## Current — how it is

| Document | What it says |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How kraftverk is built, and why: the layers, the rules, the decisions, and the steps taken and to come. The authority |
| [HANDOFF.md](HANDOFF.md) | Where things stand: what works, what is next, what to know before changing anything |
| [DATA-MODEL.md](DATA-MODEL.md) | Adding a device screen by screen, what code declares, and every table the database holds |
| [API.md](API.md) | The HTTP API a server answers |
| [CONFIG.md](CONFIG.md) | The configuration file: its language, its versions, its secrets |
| [AUTOMATIONS.md](AUTOMATIONS.md) | Automations: the rule, its triggers and conditions, watching and acting |
| [SEQUENCES.md](SEQUENCES.md) | Automations that take steps: waits, retries, choices, and their runs |
| [SHARED-PARTS-AND-RESERVE.md](SHARED-PARTS-AND-RESERVE.md) | Parts shared between automations, and the reserve the gateway keeps |
| [AUTOMATION-EDITOR.md](AUTOMATION-EDITOR.md) | Building an automation from blocks, and where each piece lives |
| [ADDING-A-DEVICE.md](ADDING-A-DEVICE.md) | How support for a new product gets in: its packages, and what each declares |
| [ACCOUNTS.md](ACCOUNTS.md) | Accounts, homes and a hosted kraftverk: what is decided, and the direction |
| [SECURITY.md](SECURITY.md) | Who may do what, the two entrances, and recovering access |
| [RUNNING.md](RUNNING.md) | Running it: development, production on a host, and in Docker |
| [DOCKER.md](DOCKER.md) | The containers, their settings and data, and diagnosing a problem |
| [BROKER.md](BROKER.md) | The MQTT broker stations connect to |
| [DEVELOPING.md](DEVELOPING.md) | Working on the code: the layout, the tests, the end-to-end suite |
| [CI.md](CI.md) | What every push is checked by, and the deploy |
| [TUYA-LOCAL-KEY.md](TUYA-LOCAL-KEY.md) | Getting a Tuya plug's local key, once |
| [PRODUCT.md](PRODUCT.md) | What kraftverk is for, beside Home Assistant, and the plan for it as a product |

## Plans and records — kept as they were written

| Document | What it was |
| --- | --- |
| [PROJECT-BRIEF.md](PROJECT-BRIEF.md) | The first brief: the station, the plug, the safety rules and a staged plan |
| [P280-FINDINGS.md](P280-FINDINGS.md) | What was established against a real P280, as it was found |
| [ATORCH-S1W.md](ATORCH-S1W.md) | What was established about the ATORCH plug and the Tuya local protocol |
| [PROPOSITION.md](PROPOSITION.md) | Why the direction is right for an AI-first world, 2026-09-29 |
| [NEXT-STEP-ARCHITECTURE.md](NEXT-STEP-ARCHITECTURE.md) | A review of the whole system on 2026-09-29, and the plan that followed |
| [PLAN-SHARED-CORE.md](PLAN-SHARED-CORE.md) | The plan that moved the core out of the server, so the app runs a home too |
| [PLAN-RUN-AND-CHAIN.md](PLAN-RUN-AND-CHAIN.md) | The plan for runs, chains, shared parts and the reserve |
| [PLAN-CONFIG.md](PLAN-CONFIG.md) | The plan for configuration as a language, with import and export |
| [AUTOMATIONS-UX.md](AUTOMATIONS-UX.md) | The plan for the automation screens at phone size, 2026-10-01 |
