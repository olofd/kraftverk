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
| [AUTOMATION-LANGUAGE-STATUS.md](AUTOMATION-LANGUAGE-STATUS.md) | The automation language: what is done of its plan, and what is left, in order |
| [SHARED-PARTS-AND-RESERVE.md](SHARED-PARTS-AND-RESERVE.md) | Parts shared between automations, and the reserve the gateway keeps |
| [AUTOMATION-EDITOR.md](AUTOMATION-EDITOR.md) | Building an automation from blocks, and where each piece lives |
| [ADDING-A-DEVICE.md](ADDING-A-DEVICE.md) | How support for a new product gets in: its packages, and what each declares |
| [PORTING-FROM-HOME-ASSISTANT.md](PORTING-FROM-HOME-ASSISTANT.md) | How an integration in Home Assistant becomes one here: the map, the recipe, licences, and what is not built yet |
| [ACCOUNTS.md](ACCOUNTS.md) | Accounts, homes and a hosted kraftverk: what is decided, and the direction |
| [SECURITY.md](SECURITY.md) | Who may do what, the two entrances, and recovering access |
| [RUNNING.md](RUNNING.md) | Running it: development, production on a host, and in Docker |
| [DOCKER.md](DOCKER.md) | The containers, their settings and data, and diagnosing a problem |
| [BROKER.md](BROKER.md) | The MQTT broker stations connect to |
| [DEVELOPING.md](DEVELOPING.md) | Working on the code: the layout, the tests, the end-to-end suite |
| [CI.md](CI.md) | What every push is checked by |
| [DEPLOY.md](DEPLOY.md) | Deploying it: the pipeline on Forgejo, the deploy script, the server's setup |
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
| [PLAN-AUTOMATION-LANGUAGE.md](PLAN-AUTOMATION-LANGUAGE.md) | The plan for the automation language's next level: one registry of constructs, typed expressions, bounded-complete power, the editor — and where it stands against Home Assistant and the rest, 2026-10-04 |
| [AUTOMATIONS-UX.md](AUTOMATIONS-UX.md) | The plan for the automation screens at phone size, 2026-10-01 |
| [PLAN-INTEGRATIONS.md](PLAN-INTEGRATIONS.md) | The design for integrations: integration and service as words, accounts and bridges, the manifest and catalogue, setup that asks again, porting Home Assistant's integrations and running them beside kraftverk, 2026-10-06 |
| [ICLOUD.md](ICLOUD.md) | Signing in to iCloud as Apple asks in 2026: what went wrong, what exists elsewhere, the screens, staying signed in, the bridge, and the order of work, 2026-10-08 |
| [PLAN-MAPS.md](PLAN-MAPS.md) | Maps and where things are: MapLibre over self-hosted Protomaps tiles, regions the server downloads, tracking turned on per device, and a phone's own screen, 2026-10-08 |
| [PLAN-WORLD-MODEL.md](PLAN-WORLD-MODEL.md) | The world beyond devices, table by table: people and their keys, families, homes and zones, spaces and openings, where any device is (reported or placed, on the globe or in a room's frame), presence and privacy, pictures, labels, notifications, the three kinds of database, the configuration file's version 10, and the decisions for the owner, 2026-10-08 |
| [PLAN-WORLD-MODEL-WORK.md](PLAN-WORLD-MODEL-WORK.md) | Building the world model: W1 to W8 cut into slices that are each green, what each changes and where, its tests, when it is done, and the risks, 2026-10-08 |
| [RESEARCH-SCRIPTS.md](RESEARCH-SCRIPTS.md) | Scripts in TypeScript, as powerful as a person in kraftverk: sandboxes on Bun, the browser and React Native (QuickJS everywhere), type checking and an editor in the app, the SDK as `KraftverkApi` typed by the home, and the decisions for the owner, 2026-10-09 |
| [RESEARCH-HOME-ASSISTANT.md](RESEARCH-HOME-ASSISTANT.md) | Kraftverk's automations against Home Assistant's, area by area: scores, where kraftverk leads, the gaps that cost a power user, and the ten things to build to surpass it, 2026-10-09 |
| [PLAN-VARIABLES-AND-TRIGGERS.md](PLAN-VARIABLES-AND-TRIGGERS.md) | Home variables (typed, shared state: toggles, numbers, counters, timers, schedules, derived values) and a family of triggers (changes, start, dates, a time from something, every from 1 min, webhooks, MQTT): the plan, its slices, and the owner's decisions, 2026-10-09 — V1, T1 and V2's timers built (§7) |
| [PLAN-SCRIPTS.md](PLAN-SCRIPTS.md) | Building scripts: the answers taken, the architecture, how a script is stored (its table, who it acts for, the file's version 17), the guest SDK and its four host functions, the gate every call passes, the sandbox's port and its two engines, the language's script step and functions, types and the editor on web and phone, and the slices S0 to S10, 2026-10-09 |
| [PLAN-ZIGBEE.md](PLAN-ZIGBEE.md) | Zigbee through a USB dongle, and MQTT made first-class: Zigbee2MQTT at the edge or native, the broker for a bridge, the integration, pairing, and the order of work, 2026-10-07 |
