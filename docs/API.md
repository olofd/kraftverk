# The HTTP API

Every endpoint the server has, and every setting it reads from its
environment. The typed client is `packages/api-client`; the shapes it speaks
are declared once, in `packages/api-contract`.

## Endpoints

Base URL: `http://<host>:3333/api` — or, in Docker, through the web container:
`http://<host>:8080/api`.

Every route passes one gate: a session cookie, reads and writes alike, from any
network. Only the sign-in routes are open, and `/health` answers the server's own
machine. Every request that changes anything must carry an `X-Kraftverk-Client`
header. See
[docs/SECURITY.md](SECURITY.md).

Everything is device-scoped: a route names the device it acts on. `:id` is an
opaque catalog id (`d-3db445e0a1b2`; older ones look like
`power-station:3db445e0`), so URL-encode it. A device's own permanent id — its
MAC, a Tuya device id — is `identity`, a separate field: it is how the same
device is recognised however it is found, and why removing one and adding it
again can bring its history back. Health is not a boolean: `health.status` is
one of `connected`, `connecting`, `offline`, `unconfigured` or `error`, and
always comes with a sentence in `health.detail`. Nothing here names a device
type: a type's own tools are declared as data — what each asks for and what it
answers — and listed on the device as `tools`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness — for the server's own machine (the container healthcheck) and signed-in sessions |
| `GET` | `/auth/state` | Who you are, whether this network is trusted, whether setup is due |
| `POST` | `/auth/setup` · `/auth/login` · `/auth/logout` | The first account (home network only), signing in and out |
| `POST` | `/auth/password` | Your own password; needs the current one |
| `GET` `POST` `DELETE` | `/users` · `/users/:id` · `/users/:id/password` | Accounts |
| `GET` | `/version` | Name, version, runtime, uptime; simulator or not, transports, read-only |
| `GET` | `/device-types` | What can be added: categories, installed types, and whether this server can hold each method |
| `POST` | `/setup` | Start adding a device over a method this server will hold; the steps follow |
| `GET` `PATCH` `DELETE` | `/setup/:id` | The draft; values from a form step (secrets stay here); discard it |
| `GET` | `/setup/:id/sightings` | What the transport sees that this type's protocol recognises, marked when already yours |
| `POST` | `/setup/:id/choose` · `/steps/:step/actions/:action` · `/steps/:step/discover` | Choose the device; run a step's helper ("fetch the key") on the server |
| `POST` | `/setup/:id/check` · `/setup/:id/save` | Read it once — new, yours, yours before, another model — then save it all in one go |
| `POST` | `/setup/app` | A connection this app will hold: what it learnt reading the device itself, never a secret |
| `GET` | `/devices` · `/devices/removed` | The devices you have, each with its description (parts, attributes, events), information, live readings, health, connections and links; removed ones, with their history |
| `GET` `PATCH` `DELETE` | `/devices/:id` | Read; rename, or give it another key (`{ name?, key? }`: the name a configuration knows it by, lowercase letters, digits and dashes, no other device's — 409 when taken; on the timeline as `device.keyed`); or remove — keeping its history |
| `PUT` | `/devices/:id/picture` | Which picture it shows, `{ picture }`, a reference: `type:N` is its type's Nth (its package's, shipped with the app), counting from 0; the device's `picture` says the one shown. `own:<id>` is reserved for a photo of its own — not built yet, refused — which will be uploaded with `POST /devices/:id/pictures`, served from `GET /devices/:id/pictures/<id>`, and chosen here the same way. Audited |
| `POST` | `/devices/:id/delete-history` | Delete a removed device and everything it recorded; its name, typed, confirms it |
| `PATCH` | `/devices/:id/attributes` | Change what a device remembers — the attributes its description says can be written — through the action gateway; a refusal that only wants a person's yes carries `needsConfirmation`: a token for this patch and this person, good once for a minute, sent back as `confirmation`. A write answers with `settlingMs`: how much of its dwell is left, before which the same setting is refused again |
| `POST` | `/devices/:id/parts/:part/commands/:capability/:command` | Every command, to one part of a device, with typed `args` — through the action gateway; a refusal that only wants a person's yes carries `needsConfirmation`, a token for this command and this person, sent back as `confirmation` |
| `GET` | `/devices/:id/events` | What the device said happened, newest first |
| `GET` `POST` | `/devices/:id/tools/:name` | A device type's own tools, declared as data: register dump, snapshot, scan, raw frame. The input is checked against what the tool asks for (400) and the answer against what it declares (502). Reads are GETs, their input in the query; writes are POSTs of `{input, confirmation}`, refused while read-only (423) and audited. One that declares what it cannot undo is refused first (409) with `needsConfirmation`: a token for this tool, input and person, good once for a minute, sent back as `confirmation` |
| `GET` | `/devices/:id/history` | One measurement over time, thinned for a chart: the last `hours`, or `from` to `to` |
| `GET` | `/devices/:id/changes` | Every change of an on/off or an enum in a span (`hours`, or `from` and `to`; one `key` or all), exactly when it happened, with each key's value from before the span |
| `POST` `PATCH` `DELETE` | `/devices/:id/connections/:connection` (`/prefer`) | Prefer one way to reach it; let its secrets leave in an export as plain text or not (`PATCH { secretsExportable }`, a server-held one only, on the timeline as `device.exportable`); or remove one — not the last |
| `PUT` | `/devices/:id/connections/:connection/secrets` | Replace a server-held connection's secrets, such as a plug's new local key |
| `POST` `DELETE` | `/links` · `/links/:id` | Facts about the house, between parts: `{kind, source: {device, part}, target: {device, part}}` — this plug's relay feeds that station's mains input |
| `GET` `POST` `DELETE` | `/clients` · `/clients/:id` | The phones and browsers that hold connections |
| `POST` | `/devices/:id/readings` · `/clients/:id/audit` | What an app sends for a connection it holds |
| `GET` `PUT` | `/devices/:id/store` · `/devices/:id/store/:key` | A device's own store, for a session an app runs |
| `GET` | `/transports` · `/transports/:id/diagnostics/:name` | What this server reaches devices over, and each transport's diagnostics — the broker, its journal, its traffic |
| `GET` | `/found` | What the transports see that nothing you have is reached by |
| `GET` | `/diagnostics/log` | The server's own recent log (`?level=warn`, `?limit=`), and where its daily files are |
| `GET` | `/audit` | The timeline: intents, commands, verification outcomes — all of it, or one `resourceKind`'s (`device`, `client`, `automation`, `account`, `transport`), or one `resource`'s; `before` an entry's id pages back |
| `GET` `PUT` | `/policy` · `/policy/:name` | What the home decides that declarations name: `loadWatts`, how much a load is before turning it off is confirmed; `reserveSoc`, the charge below which switching on what drains a battery is refused to automations and assistants and confirmed by a person (0, none). `{ value }` sets it, `null` puts back the default; audited |
| `GET` (WebSocket) | `/live` | What changed, as it changes — see below |
| `GET` | `/problems` | Warnings and errors across the devices you have, newest first |
| `GET` `POST` `PATCH` `DELETE` | `/automations` · `/automations/recipes` · `/automations/draft` · `/automations/:id` · `/automations/:id/check` | Automations, each its own rule (docs/AUTOMATION-EDITOR.md). `recipes`: the recipes to copy from, each with its `rule`, and the installed `functions` a block may call. `draft`: `{ rule, roles, starts, self? }` checked and said, nothing kept — every problem at once, by the step it is in ("Step 2: which setting?"), and the sentence, triggers and steps in words. `POST` makes one — `{ name, key?, rule, roles, starts, madeFrom?, timeZone, recheckMinutes? }` (its key made from its name when not given), the rule with no settings of its own, every role filled (a part in `roles`, another automation in `starts`), no chain it starts coming back to it or going deeper than 4 — observing; `PATCH` changes its name, its `key` (409 when another has it), mode, clock, `recheckMinutes`, its place on the home page (`homePlace`, `null` to take it off), or its rule — `rule`, `roles` and `starts` together. Letting it act, and while it acts changing its rule or `recheckMinutes` (how often a condition that still holds runs it again; `null`, never), is refused with 409 and `needsConfirmation`, sent back as `confirmation`. `check` says what it would do now, and does nothing. `?device=` lists those a device fills a role of. Each automation carries its `rule`, `madeFrom` (`{ id, label }` or `null`), `homePlace`, `sharedWith` (the other automations that change a part it changes, and which parts), `now` (each condition and whether it holds, and the readings it stands on), `nextLookAt`, its `sentence`, `when`, `steps` and `otherwise` in words, `takesSteps`, `problems`, the run it takes now (`running`) and its `lastRun`: a run with `why`, `saw`, `conditions`, `startedByRun` and each of its `steps`. A sequence cannot keep things so (400); deleting one tells those that start it |
| `POST` · `POST` | `/config/plan` · `/config/apply` | Importing a configuration (docs/CONFIG.md). `plan`: `{ text, mode: merge \| replace, passphrase? }` — the text a whole file, or one device's or automation's own YAML — or `{ restored: true }`, the copy the last restore was made from, again — → what it would do, nothing written: problems with their lines, each device, link, automation and home value added, brought back (a device you removed, with its history: `restore`), changed (in words), the same or removed, and what it needs — a passphrase, a secret, a device of yours for a role naming one you do not have (with candidates), a yes. `apply`: `{ plan, include?, secrets?, rebind?, confirmation? }` → what it did, in one transaction; 409 with `needsConfirmation` when it sets an automation acting or removes; 400 with `problems` when it cannot. On the timeline as `config.imported` |
| `GET` · `GET` · `POST` · `GET` | `/config/schema.json` · `/config/vocabulary` · `/config/export` · `/config/snapshot` | Configuration (docs/CONFIG.md). `schema.json`: the JSON Schema of a configuration file — the installed types, their settings, ways and secrets — **open without a session**, as an editor fetches it, and naming nothing you have. `vocabulary`: what a file may name here, with the keys of your devices and automations: what the app's editor checks against. `export`: `{ devices?: [keys], automations?: [keys], secrets: none \| sealed \| plain, passphrase? }` → `{ text, notes }`, the YAML and what could not go in; secrets sealed with the passphrase (12 characters at least), plain only for connections whose owner allowed it; one that carries secrets is on the timeline (`config.exported`). `snapshot`: where the configuration kept beside the database is, when it was last written, and what restoring it last did (`restored`) |
| `GET` | `/automations/:id/runs/:runId/log` | One of its runs with its log (docs/SEQUENCES.md): the `run`; the `devices` it used and the `roles` they filled, as they were; `keys`, what each value is (`part`, `label`, `kind` number · boolean · enum · text, `unit`, `quantity`, `words`, `options`); every reading, `{ device, key, at, heardAt, value }`, the earliest first; `reach`, each change in whether a device could be reached and why not; and `capped` when it gave more readings than a run keeps. `?format=csv`: its steps, readings and reachability as one table in time order (`at, heard_at, type, device_id, device, part, key, label, step, value, unit, detail`), to download. 404 for a run not its own |
| `POST` · `POST` · `GET` | `/automations/:id/start` · `/automations/:id/stop` · `/automations/:id/runs` | Any automation, started by hand (docs/SEQUENCES.md): `start` begins its run, for real whatever its mode, and answers with the automation running — or ended, if it did all at once; `stop` ends the step it is in, stops what it started and waits for, and runs its `otherwise`; 409 in words when off, already running, or not running. The assistant's `start` may start only one let act. `runs`: every run, the latest first, each with its steps and the run that started it (`startedByRun`). A run's progress is said on the live stream as `{ type: 'automation', id }` |
| `POST` · `GET` | `/automations/rehearse` · `/automations/:id/rehearse` | A rule rehearsed on the last `hours` of history — a draft (`{ rule, roles, starts, timeZone, hours }`) or one kept: when it would have run and what it would have done, and what history could not show. Nothing is sent |
| `GET` | `/world` | The house as a model reads it: every device, its parts, what each offers and reports with meaning and freshness, the links, and the rules an assistant is held to. `?format=text` is the same in a few lines a device |
| `GET` | `/vocabulary` | The words the world is said in: capabilities (commands, queries, what makes a command consequential), meanings, link kinds, recipes, the home's policy values |
| `POST` | `/mcp` | MCP over HTTP (JSON-RPC, no stream) — see below |

## The assistant: MCP

`POST /api/mcp` speaks the Model Context Protocol, JSON in and JSON out, behind
the same sign-in as every route: a client sends the session cookie and the
`x-kraftverk-client` header, as the app does. Its tools are the intents and
nothing else:

| Tool | What it does |
| --- | --- |
| `world` | The house now, as `GET /world?format=text` |
| `vocabulary` | As `GET /vocabulary` |
| `command` | One command to one part, through the gateway as `actor: 'agent'`: arguments, dwell time and freshness checked, the effect read back. What needs a person's confirmation is refused to an agent — it cannot say yes for anyone — and the refusal says so |
| `query` | A capability's query, answered in its declared type |
| `receipts` | The timeline, one device's or one automation's |
| `rehearse` | A recipe with its roles and settings, copied into a rule of its own and rehearsed on history |
| `automations` | The automations there are: each one's sentence, whether it acts on its own, whether anything starts it on its own, and its run now or its last |
| `start` · `stop` | Start one its owner has let act — as the assistant, with an assistant's dwell — or stop a run in progress |
| `propose` | An automation copied from a recipe, its settings written into its blocks, made **observing** — it acts on its own only once a person lets it, in the app, where they can also change any of its steps — and rehearsed on the last week |

A client configured with, say,
`{ "type": "http", "url": "http://localhost:3333/api/mcp", "headers": { "Cookie": "kraftverk_session=…", "x-kraftverk-client": "mcp" } }`
reads the house and acts in it with exactly those rails. A token of its own,
rather than a person's session, is still to come.

## The live stream

`GET /api/live` opens a WebSocket that carries what changed, server to app
(`LiveUpdate` in `packages/api-contract`):

| Message | Meaning |
| --- | --- |
| `{ type: 'hello', at }` | Open. Read the list (`GET /devices`) now, and apply what follows on top of it |
| `{ type: 'readings', deviceId, readings }` | Only the readings whose values moved: merge them by key |
| `{ type: 'health', deviceId, health }` | A device's health, when it changed (and at least every 30 s while readings keep arriving) |
| `{ type: 'event', deviceId, event }` | Something a device said happened |
| `{ type: 'automation', id }` | An automation was made, changed or deleted — or one it starts was deleted — or a run of it moved (started, a step, ended): read the automations again |
| `{ type: 'changed', deviceId: null }` | What a list of devices shows changed, and the stream does not carry it in detail — a device saved, renamed or removed, a connection, its picture, a link, an app forgotten, what a device is, one an app holds coming back: read the list again. Nothing else says it: a setup step, a policy value, a command or a setting does not |

Readings an app sends for a device it holds (`POST /devices/:id/readings`)
go out as `readings`, as a server-held device's do.

For each socket, the updates waiting to be sent are combined: a reading by its key, health by its device. They go out at most four
times a second. A socket that is not draining is sent nothing until it does,
then the latest. The gate applies as to every route (the session cookie
travels with the socket), and two more rules do too: a browser page from
another website is refused by its `Origin` (a WebSocket cannot carry the
`X-Kraftverk-Client` header, so this takes its place; the native app sends
no Origin), and the socket is closed (code `4401`) within a minute of its
session ending.

The app reads the list when the socket opens, and polls every five seconds
only while it is down; closes it in the background; and opens it again with a
growing wait, up to half a minute. Nothing depends on it being up.

### What the app says back: what its screen shows

The one message an app sends on the socket (`ViewReport`); anything else is
ignored:

```json
{ "type": "view", "screen": "device/[id]", "showing": [{ "kind": "device", "id": "d-…" }] }
```

- **`screen`** is the route, never an address with ids in it (`home`,
  `device/[id]`, `automation/[id]`). **`showing`** is what is on it:
  `{ kind: 'device' | 'automation', id }`, each once.
- **A fact, not a request.** The server keeps it while the socket is open
  (`server/src/attention`), and what follows is its own judgement: today, a
  device shown is read more often — the same wish an automation waiting on it
  makes (`wantFresh`), renewed every 10 s while it is shown and lapsing 30 s
  after.
- **When it is said:** when what the screen shows changes (settled for
  0.25 s), each time the socket opens, and at most once a minute while
  someone uses the app (a touch, a click, a key, a scroll). An app that says
  nothing for ten minutes is taken for unattended: a page left open in a tab
  overnight keeps nothing fresh.
- Kept in memory only, per open socket, with who is signed in on it: nothing
  of it is written down.

## Environment

| Variable | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `READ_ONLY` | `--read-only` | on in the dev scripts | Refuse every write to hardware. Simulated devices take writes either way. There is no transport setting: every installed transport is available, and each device is reached the way it was added — or simulated |
| `PORT` / `HOST` | — | `3333` / `0.0.0.0` | HTTP API |
| `MQTT_PORT` / `MQTT_HOST` | — | `1883` / `0.0.0.0` | Where the MQTT broker listens for stations |
| `BROKER_HOST` / `BROKER_ADMIN_URL` | — | `127.0.0.1` / `http://127.0.0.1:3883` | Where the server reaches the broker |
| `BROKER_SPAWN` | — | on | `0` stops the server starting a broker, for when it runs as its own service. The rest of the broker's settings are in [docs/BROKER.md](BROKER.md#environment) |
| `ALLOWED_ORIGINS` | — | — | Browser origins allowed to call the API with your session, comma-separated. Not needed for the web container (same origin) or the native app; in development the Expo dev server on a private address is allowed on its own. `*` is refused |
| `KRAFTVERK_ALLOWED_HOSTS` | — | — | Names the server answers to besides addresses and local names, such as a DDNS name. Others get `421` (DNS-rebinding defence) |
| `KRAFTVERK_TRUSTED_PROXIES` | — | — | The web container, whose home-network/public entrance stamp is believed. See [docs/SECURITY.md](SECURITY.md) |
| `ALLOW_RAW_FRAMES` | — | — | `1` lets a device type's raw-frame tool send frames nobody has described. The protocol's guard still applies |
| `KRAFTVERK_DB` | — | `server/data/kraftverk.db` | Where the database lives. **Required under `NODE_ENV=test`** — the server refuses to open the default file from a test run |
| `KRAFTVERK_RESET_SECRET_FILE` | — | `server/data/reset-secret` | A passphrase of 16+ characters here lets the app empty the database from **App settings → Danger zone**. No file means the route does not exist; the app shows how to enable it rather than a dead button. Gitignored |
| `KRAFTVERK_SECRET_KEY` | — | — | Passphrase for AES-256-GCM secrets, such as a plug's local key. Without it they are stored as given, and the UI says so |
