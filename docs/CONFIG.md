# Configuration: a home in one file

**Status:** the language, the export, the JSON Schema and the snapshot kept
beside the database are built (2026-10-01; [PLAN-CONFIG.md](PLAN-CONFIG.md)
phases 1–2). Import, restore after a reset and the app's editor follow.

A kraftverk home — its devices, how each is reached, the links between them,
its automations and the home's own values — written as one YAML document.
The database stays the live truth; the configuration is what you export, back
up, move, write by hand, and what carries the home across a database reset
(the database is evergreen: a new schema sets it aside, and the server
restores from the configuration it keeps beside it).

The language lives in `packages/config`: pure, so the server and the app read
and check a file with the same code.

## A file

```yaml
# yaml-language-server: $schema=http://<your server>/api/config/schema.json
kraftverk: 1                      # the document's version: required

home:
  policy: { loadWatts: 50, reserveSoc: 20 }

devices:
  garage-station:                 # its key: what everything else names it by
    type: acme.station
    name: Garage station
    connect:                      # the ways it is reached, preferred first
      - via: bluetooth
        address: "AA:BB:CC:DD:EE:01"
  smart-plug:
    type: acme.zigbee-plug
    name: Smart plug
    connect:
      - via: lan
        address: 192.0.2.10#a4c1380000000001
        settings: { deviceId: bf7c0000000000000000zp }
        secrets: { localKey: !secret smart-plug.localKey }

links:
  - feeds: { from: ac-in-meter, to: garage-station.input.ac }

automations:
  start-charging-the-scooter:
    name: Start charging the scooter
    mode: watch                   # off · watch · act
    clock: Europe/Stockholm
    uses:
      supply: garage-station.outlet.ac   # a device's key, and one of its parts
      charger: smart-plug                # a device alone is its main part
    do:
      - turn on: supply
      - wait until: charger reachable
        at most: 2 min
      - turn on: charger
      - make sure: charger.power.draw > 50 W
        within: 20 s
        tries: 5
        each time:
          - turn off: charger
          - wait: 5 s
          - turn on: charger
    if a step fails:
      - turn off: charger
      - turn off: supply

secrets:
  smart-plug.localKey: sealed:v1:…
```

**Keys.** Every device and automation has a key — lowercase letters, digits
and dashes — made from its name when it is added and changeable afterwards. A
file names things by key; an import matches by key.

## Rules in words

An automation's rule is written in words whose parse tree *is* the rule: what
the file says is exactly what the engine runs, the checker checks and the app
describes.

- **What starts it** (`when:`):
  - `at: "07:00"`, with `days: weekdays`, `weekends` or `[mon, fri]`
  - `every: 15 min`
  - `event: mains.lost` with `from: station`
  - `becomes: <condition>`, with `for: 2 min`
- **Only when** (`only if: <condition>`).
- **What it does** (`do:`), and what it does if a step does not succeed or it
  is stopped (`if a step fails:`):

  | Step | Says |
  |---|---|
  | `turn on: role` · `turn off: role` | switch a part |
  | `switch: role` + `on: <condition>` | on while the condition holds, off when it does not |
  | `send: command` + `to: role` + `capability:` + `with: {…}` | any command of a capability |
  | `set: role` + `setting: key` or `meaning: battery.chargeLimit` + `to: <value>` | change a setting |
  | `wait: 5 s` | a pause |
  | `wait until: <condition>` + `at most: 2 min` | until it holds — every wait has its limit |
  | `make sure: <condition>` + `within:` + `tries:` + `each time: [steps]` | retry until it holds |
  | `if: <condition>` + `then: [steps]` + `else: [steps]` | a choice |
  | `watch: <condition>` + `for: 5 s` + `if it stays so:` + `if not:` | watch, then choose |
  | `start: role` + `and wait: 10 min` | start another automation |

- **Conditions and values** are expressions:
  - a reading: `role.meaning` — `charger.power.draw`, `station.battery.soc`;
  - `role reachable`;
  - numbers with units — `50 W`, `15 %`, `30 min` — times of day `07:00`,
    `"text"`, `true`, `false`;
  - `< <= > >= == !=`, joined with `and`, `or`, `not`, and parentheses;
  - `time between 23:00 and 05:00` (across midnight when the end comes first);
  - `+`, `-`, `min(a, b)`, `max(a, b)`;
  - a package's function: `call open-meteo.weather.skyLooks(forecast, cloudMax = 40)`.
- **Lengths of time**: `5 s`, `2 min`, `1 h`.
- **What fills a role** (`uses:`): `device-key` or `device-key.part`; another
  automation as `{ automation: key }`. A role's label and what it needs come
  from what the rule does with it; say them only when they differ:
  `{ part: …, label: …, description: …, needs: [switch, powerMeter] }`.

Anything text cannot say exactly — a list as a value — is kept as the rule's
own data in its place; a file the server writes always reads back the same.

## Secrets

A connection's secrets (a local key, a password) are written:

- `!secret name` — kept by name, under `secrets:` at the end of the file;
- `sealed:v1:…` — sealed with a passphrase: an export that carries its
  secrets seals them with one you type, at least 12 characters (scrypt, then
  AES-256-GCM); it opens on any kraftverk given the passphrase, and on none
  that is not;
- the text itself — only for a connection whose owner chose to let its
  secrets leave in plain text (off unless chosen, and warned against).

An export leaves secrets out unless asked: then sealed, or plain where
allowed. The server's own snapshot keeps every secret sealed with the
server's key (`KRAFTVERK_SECRET_KEY`), or as the database keeps them without
one; it never leaves the server.

## Writing one in an editor

The server serves the JSON Schema of what is installed at
`/api/config/schema.json` — open without logging in, since an editor cannot,
and naming nothing you have. In VS Code, with Red Hat's YAML extension, the
first line of the file does the rest:

```yaml
# yaml-language-server: $schema=http://<your server>/api/config/schema.json
```

and, so `!secret` is understood, in VS Code's settings:

```json
"yaml.customTags": ["!secret scalar"]
```

The editor then completes types, their settings and secrets, and flags a
required field left out. What a schema cannot say — whether an expression
reads right, whether a key names a device — the check says:

```
npm run config -- check kraftverk.yaml
```

prints each problem as `file:line:column: message` against the device types
installed in this checkout (`devices=a,b automations=c` for keys the server
has but the file does not carry), and `npm run config -- schema` prints the
schema.

## Versions

The configuration is the one thing in kraftverk versioned on purpose
(AGENTS.md). `kraftverk: n` at the top says which version wrote it; each
change to the document's shape adds a migration from n to n + 1
(`packages/config/src/migrate.ts`) with a kept fixture of version n, so every
newer kraftverk reads every older file. A file from a newer kraftverk is
refused, saying so.

## Where it is kept

Beside the database, in `config/kraftverk.yaml` (`/data/config/` in the
container): written within two seconds of any change to devices, their
connections and secrets, links, automations or the home's values; the five
before it kept as `kraftverk.yaml.1` … `.5`; only rewritten when it says
something new. `GET /api/config/snapshot` says where, and when it was last
written.

## The API

- `GET /config/schema.json` — the JSON Schema (open).
- `GET /config/vocabulary` — what a file may name here: the installed types,
  their settings, ways and secrets, the kinds of link, the home's values, and
  the keys of what you have. What the app's editor checks against.
- `POST /config/export` — `{ devices?: [keys], automations?: [keys],
  secrets: none | sealed | plain, passphrase? }` → `{ text, notes }`: the file,
  and what could not go in. An export that carries secrets is on the
  timeline.
- `GET /config/snapshot` — the snapshot's path and when it was last written.
