# Plan: configuration as a language — devices and automations in a file, import and export

## Context

Today a device exists only through the interactive add flow, and an
automation only through the editor. Both live only in the database. Every
schema change sets the database aside (strict v1, evergreen schema), so the
owner re-adds the P280, the ATORCH, the NIU, the Zigbee plug (with its key)
and every automation by hand. That has happened twice today.

The owner wants:
- a **configuration language**: devices and automations written in a file,
  schema-checked as they are typed (an editor complains about a missing
  required field), secrets included, so that devices "just show up";
- **export and import**: one device, one automation, or the whole server, as
  a backup and to move things;
- a format **bound to its own schema, not to the database**, and **versioned
  with migrations**, while the database stays evergreen. The config is what
  carries the home across a reset.

The owner's decisions (2026-10-01):
1. **YAML with a JSON Schema**, generated from the installed device types and
   served by the server, so VS Code (with the YAML extension) completes and
   checks as you type.
2. **A readable DSL for rules**: steps as short verbs, conditions as small
   expressions (`charger.power.draw > 50 W`).
3. **The database stays the live truth; the config is kept beside it.** The
   server rewrites a snapshot after every change and restores from it, by
   itself, when a schema change starts a fresh database. Import and export
   by hand on top.
4. **Secrets**:
   - an export leaves secrets out by default;
   - asked to include them, it seals them with a passphrase;
   - plain-text secrets go out only for connections saved as "exportable in
     plain text": a choice made when the device is added, or later, with a
     warning, and off by default.
   - The server's own snapshot always keeps every secret, sealed as the
     database seals them; it never leaves the server.

What is known: devices are `device` + `device_connection` + `connection_secret`
+ `device_link` rows. Automations are `automation` + `automation_role`. Home
policy lives in `app_state` (`server/src/history/schema.ts`). Every type, method
and protocol already declares its fields in `ConfigSchema`
(`packages/device-sdk/src/schema.ts`: `required`, `presentation: 'secret'`,
`validateConfig`, `withoutSecrets`). The rule language has `checkRule` and
`checkBinding` (`packages/device-sdk/src/automation.ts`). Secrets are sealed by
`sealSecret`/`openSecret` (`server/src/history/db.ts`, AES-256-GCM when
`KRAFTVERK_SECRET_KEY` is set). The device save path is
`server/src/devices/setup/save.ts` (`writeSaved`).

## 1. Data model (one schema change, the database set aside once)

- **`device.key`** `TEXT NOT NULL`: its name in configuration (`garage-p280`).
  - Unique among devices not removed (a partial unique index).
  - Made from the name when saved (lowercased, dashes, deduplicated with
    `-2`), and changeable in the device's Advanced section.
  - What a config file references, and what an import matches on.
- **`automation.key`** `TEXT NOT NULL UNIQUE`: the same, for automations.
- **`device_connection.secrets_exportable`** `INTEGER NOT NULL CHECK (0, 1)`:
  whether its secrets may leave in plain text. Off unless chosen.
- Nothing else. History, runs and their logs stay database-only and start
  afresh after a reset, as the owner accepted.
- **Not exported**:
  - accounts and passwords;
  - connections an app holds, since their keys live on the phone (an export
    says which were left out);
  - a device's own hardware settings (they live on the device).

## 2. The document — `kraftverk.yaml`, version 1

```yaml
# yaml-language-server: $schema=http://<server>/api/config/schema.json
kraftverk: 1                      # the document's version: required

home:
  policy: { loadWatts: 50, reserveSoc: 20 }

devices:
  garage-p280:
    type: aferiy.p280
    name: Garage P280
    identity: ble:…               # who the hardware says it is; optional
    settings: {}                  # its type's config fields
    connect:                      # ways to reach it, preferred first
      - via: ble                  # a method of its type
        address: AA:BB:…
  smart-plug:
    type: tuya.zigbee-plug
    name: Smart plug
    connect:
      - via: lan
        address: 192.0.2.10#a4c1380000000001
        settings: { deviceId: bf7c…, protocolVersion: "3.4" }
        secrets: { localKey: !secret smart-plug-key }   # or sealed:… / plain text

links:
  - feeds: { from: ac-in-meter, to: garage-p280.input.ac }

automations:
  start-charging-scooter:
    name: Start charging the scooter
    mode: watch                   # off · watch · act — the app's own words
    clock: Europe/Stockholm
    made from: standard.start-charging
    uses:
      supply: garage-p280.outlet.ac     # device.part; a device alone is its main part
      charger: smart-plug
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

secrets:                          # only in a sealed export: name -> sealed value
  smart-plug-key: sealed:v1:…
```

**The DSL** maps one to one onto `Rule`. The parser's tree *is* the rule:
nothing new is checked, explained or run.

- **Triggers** (`when:`):
  - `at: "07:00"`, with `on: weekdays` or `on: [mon, fri]`
  - `every: 15 min`
  - `event: station mains-lost`
  - `becomes: <expr>`, with `for: 2 min`
- **`only if: <expr>`.**
- **Steps** (`do:` and `if a step fails:`):
  - `turn on|off: role`, or `switch: role` with `on: <expr>` (on while it holds)
  - `send: role.capability.command` with `args:`
  - `set: role` with `setting: key` or `meaning: battery.chargeLimit`, and `to: <expr>`
  - `wait: 5 s`
  - `wait until: <expr>` with `at most:`
  - `make sure: <expr>` with `within`, `tries` and `each time: [steps]`
  - `if: <expr>` with `then:` and `else:`
  - `watch: <expr>` with `for:`, `if it stays so:` and `if not:`
  - `start: role`, with `and wait: 10 min`
- **Expressions** (a string):
  - values: numbers with units (`50 W`, `15 %`, `5 s`), `07:00`, `true`, `"text"`
  - a reading: `role.meaning` (`station.battery.soc`)
  - `role reachable`
  - comparisons `< <= > >= == !=`, combined with `and`, `or` and `not`
  - arithmetic `+ -`, and `min( , )` and `max( , )`
  - `time between 23:00 and 05:00`
  - a package's function: `call forecast.sunny(weather, hours: 6)`
  - parentheses
- **`uses:`**:
  - short form: `role: device.part` (its label and needs taken from what the
    rule uses it for);
  - long form: `{ part, label, needs }`;
  - another automation: `role: { automation: key }`.
- **Durations** take `s`, `min` and `h`; units are checked as the checker
  checks them today.

## 3. Packages and server — where each part lives

**`packages/config` (new, `@kraftverk/config`, pure, names no product)**
- `document.ts`: the document's types (`ConfigDocument`, `DeviceEntry`,
  `AutomationEntry`, …) and `CURRENT_VERSION`.
- `yaml.ts`: parses with the `yaml` package (new dependency).
  - Keeps every node's line and column, so a problem says `line 31, col 9`.
  - Reads `!secret name` as a secret reference.
  - Prints with stable key order, comments only where the export adds them.
- `expr.ts` and `rules.ts`: the DSL's parser and printer. Both directions,
  with positions inside an expression string.
- `migrate.ts`: `MIGRATIONS[n]` takes a version-n document to n+1, and
  `migrate(doc)` brings any older one to the current version. Each version
  bump adds a migration and a kept fixture file of the old version.
- `schema.ts`: `configJsonSchema(vocabulary)` makes a draft-07 JSON Schema:
  - one branch per installed type, discriminated by `type:`;
  - `settings` from `type.config`;
  - `via:` limited to that type's methods;
  - each method's `settings` from its config and its protocol's non-secret
    credentials;
  - `secrets:` requiring the required secret fields;
  - steps as a `oneOf` of verb shapes;
  - expressions as strings carrying the grammar in their description;
  - the server's current device keys as suggestions for `uses:` and links.
- Sealing under a passphrase (scrypt, then AES-256-GCM,
  `sealed:v1:<salt>:<iv>:<data>`) is the **server's**
  (`server/src/config/seal.ts`, Node crypto as `db.ts` uses): the package is
  shared core, pure, and the app never seals.

**`server/src/config/` (new)**
- `export.ts`: from the database to a document, for everything, chosen
  devices (with the links between them) or chosen automations (the devices
  they use listed under `requires:`). Secrets are left out, sealed, or plain
  (only `secrets_exportable` ones). It reuses the stores: `catalog`,
  `connections.secrets`, `links`, `automations`, `policyValues`.
- `plan.ts`: from a document to a **plan**, nothing written.
  1. Parse, then migrate.
  2. Check: the schema; each type's and method's `validateConfig`; references
     (`uses`, links); `checkRule` and `checkBinding`.
  3. Compare against the database by key: new, changed (field by field),
     unchanged, and with "replace everything" also removed.
  4. Say what it still needs:
     - a missing secret;
     - the passphrase for sealed ones;
     - automations that will act on their own (to be confirmed);
     - roles naming a device you don't have (to be bound to one you do);
     - conflicts: an identity or address already another device's.
- `apply.ts`: one transaction.
  - It reuses `writeSaved`'s pieces through a no-hardware path: no check, the
    identity taken from the file.
  - It reuses the automation store's create and update, and `setPolicyValue`.
  - Then `sessions.sync(catalog.list())`, so the devices connect, and one
    audit entry, `config.imported`.
  - Letting an automation act is confirmed, as in the app: a plan token bound
    to the person.
- `snapshot.ts`:
  - **Writing.** After any change to devices, connections, links,
    automations or policy (hooked where the audit records those kinds), it
    writes `<data>/config/kraftverk.yaml` within 2 s:
    - atomically, keeping the last 5 copies;
    - with every secret sealed as the database seals them.
  - **Restoring.** At start, when `db.ts` has just started a fresh database
    (set aside or new) and a snapshot exists:
    1. migrate it and apply it as a restore, with keys, identities and modes
       kept;
    2. start an automation whose rule a migration changed in `watch`, and
       say so;
    3. list anything it could not restore on the Problems page.
- **Routes** (`server/src/routes/config.ts`):
  - `GET /config/schema.json`
  - `GET /config/export` (`?devices=` `&automations=` `&secrets=none|sealed|plain`; sealed takes the passphrase in a POST body instead)
  - `POST /config/plan` (`{ text, mode: merge|replace, passphrase? }`)
  - `POST /config/apply` (`{ planId, choices: { secrets, rebind, include }, confirmation? }`)
  - `GET /config/snapshot`
  - The device and automation routes gain `key`, and the connection gains
    `secretsExportable`.
- **CLI**: `npm run config -- check file.yaml` checks offline against the
  installed packages, and prints the schema.

## 4. App

- **App settings → Configuration** (a new route, `client/app/configuration.tsx`):
  - **Export**:
    - what: everything, or chosen devices and automations;
    - secrets: leave out (the default), sealed with a passphrase, or plain
      text (it lists which connections allow it, and warns);
    - Download (`saveText` from `client/src/lib/download.ts`), or Copy.
  - **Import**: open a file or paste text, then the plan:
    - problems first, with line numbers, blocking;
    - then New, Changed (each field's before and after) and Unchanged, each
      with a checkbox;
    - a picker for each role whose device is missing;
    - password fields for missing secrets, and the passphrase if sealed;
    - the automations that will act, confirmed;
    - Apply, then the result.
  - **Kept beside the server**: when the snapshot was last written, a
    download of it, and "Restore from it".
  - **Writing it in an editor**: the schema line to copy, and how VS Code
    uses it.
- **A device's page**:
  - its ⋯ menu gains "Export";
  - Advanced gains "Name in configuration" (the key) and, per connection,
    "Its key can be exported in plain text" with a warning, both audited.
- **The add flow**: the credentials step gains the same choice, off by
  default, with the warning.
- **An automation's page**: its ⋯ menu gains "Export" and "Show as
  configuration", the DSL text read-only, so the language can be learnt from
  what you built.

## 5. Phases (each green and pushed)

1. **Model and language** — **done, 2026-10-01**:
   - the database columns (the reset this costs is the last one done by
     hand);
   - `packages/config`: the document, YAML with positions and `!secret`, the
     DSL parser and printer, migration scaffolding at v1, and passphrase
     sealing.
   - Round-trip tests: every standard recipe, every rule in the e2e and
     engine tests, and the owner's charging pair as written above all give
     `parse(print(rule)) ≡ rule`.
2. **Export and the schema**: `export.ts`, the JSON Schema and its route,
   the snapshot writer, the CLI `check`. The schema is checked in tests by
   validating fixture documents with `ajv` (a dev dependency).
3. **Import and restore**: plan and apply, references and rebinding,
   secrets, confirmation, and restore at start on a fresh database.
4. **The app**: the Configuration screen, export from a device and an
   automation, keys, the exportable choice in Advanced and in the add flow,
   and "Show as configuration".
5. **Docs**:
   - `docs/CONFIG.md`: the language reference with examples, the versioning
     rule, and the secrets modes;
   - updates to DATA-MODEL.md, API.md and HANDOFF.md;
   - **AGENTS.md**: the strict-v1 section names the config format as the one
     thing versioned on purpose, the bridge across database resets.

## Verification

- **Unit (packages/config)**:
  - the parser and printer, with error positions;
  - every migration against its kept fixture;
  - passphrase sealing: right passphrase, wrong one, a tampered value;
  - the generated JSON Schema accepting the example document and rejecting
    a device without a required secret (via `ajv`).
- **Server**:
  - export, then wipe the database, then import, gives the same devices
    (keys, identities, connections, secrets), links and automations;
  - a plan reports a missing reference by line, and a missing secret;
  - an automation set to act needs confirmation;
  - plain-text export includes only exportable secrets;
  - restore at start on a fresh database brings back the snapshot;
  - a snapshot is written after a change.
- **e2e**:
  - export a simulated device, delete it, import the file: it is back under
    the same key and connects;
  - export an automation, import it onto another device through the rebind
    picker;
  - the Configuration screen and the import plan at 320 and 375 px in
    `layout.e2e.ts`.
- **By hand on the NAS**, once phase 3 ships:
  1. the snapshot appears in `/data/config`;
  2. the next schema change restores the P280, plug and automations with
     nothing re-added.
- Every phase: `npm run typecheck`, `npm test`, `npm run check:architecture`
  and `npm run test:e2e` green before the push.
