# Configuration: a home in one file

**Status:** built (2026-10-01; [PLAN-CONFIG.md](PLAN-CONFIG.md) phases 1–4):
the language, the export, the JSON Schema, import, the snapshot kept beside
the database — restored by itself after a reset — and the app's screens and
YAML editor.

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
  `{ part: …, label: …, description: …, needs: [switch, powerMeter] }`. A
  role the rule only reads or changes a setting of asks for no capability of
  its own, and the language refuses a role any device would do: say its
  `needs`. (A file kraftverk writes always does.)

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

## In the app

- **App settings → Configuration**: when the copy beside the server was last
  written, and what the last restore did — with its copy to import again
  when it could not do it all; an **export** of everything or of chosen
  devices and automations, its secrets left out, sealed with a passphrase,
  or in plain text where allowed, then downloaded or shown; an **import**,
  pasted or opened, checked as it is typed, then read into the plan — each
  thing chosen or left out, a field for each secret it needs, a picker for
  each role naming a device you do not have (yours, and those the file
  adds), what it asks a yes to — and applied.
- **A device's settings → Configuration**: its key, changed in place; what it
  is as configuration, its secrets by name only; and an export of it alone.
  Under **Connections**, a server-held way with secrets says whether they may
  leave in plain text — off unless chosen, turning it on warned against —
  and adding a device asks the same, off.
- **An automation's page → Configuration**: its key; what it is as
  configuration, to read and to learn the language from what you built;
  **Edit as YAML**; and an export of it alone. Its form writes it either way
  — **Form** or **YAML** at the top — the same draft: a change in its YAML
  is read back into the form as soon as it reads right, and saved as the
  form saves it, letting it act asked first. Its YAML may say what the form
  does not: its mode, clock, keeping it so, its place on the home page. A
  role nothing fills yet is written empty (`plug: ~`).

The editor in a browser is CodeMirror with its YAML language: the JSON Schema
— made in the app from the vocabulary — completes keys, values and your
devices' keys and parts, and explains them on hover
(`codemirror-json-schema`; its tooltips without the code highlighter it
would load, `client/metro.config.js`). Every problem — the YAML's own, the
document's, what it means — is found by `packages/config`, the same code
the server checks with, marked where it is and listed under it. A phone's
own app writes it in a text field, its problems listed the same.

## Versions

The configuration is the one thing in kraftverk versioned on purpose
(AGENTS.md). `kraftverk: n` at the top says which version wrote it; each
change to the document's shape adds a migration from n to n + 1
(`packages/config/src/migrate.ts`) with a kept fixture of version n, so every
newer kraftverk reads every older file. A file from a newer kraftverk is
refused, saying so.

## Importing

An import is two steps, and the first writes nothing:

1. **The plan** (`POST /config/plan` with the file's text): every problem at
   its line — none, and it can be applied — and what becomes of each device,
   link, automation and home value, matched **by key**: added, changed (each
   change in words), left as it is, or — replacing rather than merging —
   removed. And what it still needs:
   - the **passphrase** its sealed secrets were sealed with;
   - a **secret** a way to reach a device needs, which the file does not
     carry and the device does not already have;
   - a **device of yours** for each role naming one you do not have — the
     plan lists those of your devices' parts that can do what the role
     needs;
   - a **yes** to each automation it would set acting on its own, and to
     what replacing would remove.
2. **The apply** (`POST /config/apply`): the plan, with those answers, in one
   transaction — an automation that fails the checks an automation made in
   the app passes undoes the devices added for it too. What it asks a yes
   to is a 409 with `needsConfirmation`, sent back as `confirmation`.

A device's type is what it is: a key naming a device of another type is a
problem, not a change. A device you removed — the same type, by its identity
or its key — is **brought back with its history**, not added beside it. An
app's own ways to reach a device are not in a configuration: its keys live
on the phone.

## Restoring after a reset

When the server starts on a database it has just made — a new schema set the
old one aside, or there was none — and a configuration is kept beside it,
it restores from it before anything is written over it: the file is copied
aside first (`kraftverk.before-<time>.yaml`, never rotated), then imported
as a merge that asks nothing — its secrets are the server's own, and what
acted acts again. A secret the server's key no longer opens leaves its
device restored without it, to be given again. What happened is on the
timeline (`config.restored`, or `config.restore-failed` with its
problems), in the server's log, and in `GET /api/config/snapshot`'s
`restored`. Accounts are not in a configuration: after a reset, the first
account is made again from the home network, as on a new server.

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
- `POST /config/plan` — `{ text, mode: merge | replace, passphrase? }` → the
  plan (`ImportPlan`): `id` (null when its problems stop it), `problems` with
  lines, `devices`, `links`, `automations`, `policy`, `needs`, `notes`.
- `POST /config/apply` — `{ plan, include?: { devices?, automations? },
  secrets?: { "device.field": value }, rebind?: { "automation.role":
  "device-key.part" }, confirmation? }` → what it did (`ImportApplied`); a
  409 with `needsConfirmation` first when it sets something acting or
  removes; 400 with `problems` when it cannot be applied.
- `GET /config/snapshot` — the snapshot's path, when it was last written,
  and what restoring it last did.
