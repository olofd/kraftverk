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

The language lives in `packages/home-file`: pure, so the server and the app read
and check a file with the same code.

## A file

```yaml
# yaml-language-server: $schema=http://<your server>/api/config/schema.json
kraftverk: 18                     # the document's version: required

family: { name: The Examples, kind: family, locale: en-GB }

people:                           # each by a key for the file; who they are is their chain
  anna-example:
    id: p-01JA8ZK3Q4R7T9V2W5X6Y8Z0AB
    name: Anna Example            # for whoever reads it: the chain says it
    role: admin                   # admin · member · child
    nickname: Mum                 # what this family calls her
    color: "#10b981"
    chain: eyJ…                   # her signed statements, as written: not to be edited
    shortcuts: [start-charging-the-scooter]   # her own home page, in order
    sharing: { level: places, keep: 90 days } # what she shares of where she is; never said: places, 90 days

labels:                           # the family's own groupings, by key
  heating: { name: Heating, color: "#f76b15" }
  upstairs: { name: Upstairs }

homes:                            # each by its key, in their order
  home:
    name: Home
    type: house
    location: { latitude: 51.48, longitude: 0, radius: 150 }   # where it is, and its geofence in metres
    time zone: Europe/London      # what its automations keep time in, unless one says its own
    policy: { loadWatts: 50, reserveSoc: 20 }
    spaces:                       # a tree, each by a key unique in the home
      house:
        kind: building
        name: House
        spaces:
          ground:
            kind: floor
            name: Ground floor
            level: 0
            plan: { picture: 3f9a…, scale: 0.02, x: -1, y: 12 }   # its drawing: metres a pixel, its top-left corner
            spaces:
              kitchen:
                kind: room
                name: Kitchen
                outline: [[0, 0], [4.2, 0], [4.2, 3.5], [0, 3.5]]   # its corners, metres
                frame: { x: 4, y: 0, turn: 0 }                    # its own frame within the floor's
          first:
            kind: floor
            name: First floor
            level: 1
            labels: [upstairs]    # on what stands in its rooms too
            spaces:
              bedroom: { kind: room, name: Bedroom, purpose: bedroom }
      garage: { kind: room, name: Garage, purpose: garage }
    openings:                     # where spaces meet, or meet the outside
      front-door: { kind: door, from: garage, to: outside, name: Front door, shape: [[0, 1], [0, 1.9]] }
    variables:                    # its own values, by key: home.var.guests in an automation
      guests: { kind: toggle, title: Guests staying }
      dryerRuns: { kind: counter, max: 99 }
      target: { kind: number, starts: 21 °C, min: 16 °C, max: 25 °C }
      laundry: { kind: choice, options: { washing: Washing, drying: Drying, done: Done } }
      wake: { kind: time, title: Wake at, starts: "06:45" }
      oven: { kind: timer, for: 20 min }   # ends on its own: changes: home.var.oven, to: ended
  cabin:
    name: Lake cabin
    type: cabin
    time zone: Europe/London

zones:                            # places the family knows that are no home, by key
  school: { name: School, location: { latitude: 51.49, longitude: 0.01, radius: 200 } }

modes:                            # the family's own, by key, beside home, away, vacation; day, evening, night
  guests-over: { axis: presence, name: Guests over }

devices:
  garage-station:                 # its key: what everything else names it by
    type: acme.station
    name: Garage station
    place: { home: home, space: garage, at: [1.5, 2] }   # where it stands; "based:" for one that moves
    labels: [heating]
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
  family-account:                 # an account: a device that others are reached through
    type: acme.account
    name: Family account
    connect:
      - via: cloud
        settings: { account: someone@example.com }
        secrets: { password: !secret family-account.password }
  hall-lamp:
    type: acme.lamp
    name: Hall lamp
    connect:
      - via: account
        through: family-account   # the device it is reached through, by its key
        address: lamp-0001        # its key there
  pocket-phone:
    type: acme.phone
    name: Pocket phone
    track: 30 days                # where it has been is kept a month: never where it was, in a file
    people: { carries: anna-example, owns: [anna-example] }   # who it is with, by the people's keys
    connect:
      - via: account
        through: family-account
        address: phone-0001

links:
  - feeds: { from: ac-in-meter, to: garage-station.input.ac }

scripts:                          # the family's own, in TypeScript, by key (docs/PLAN-SCRIPTS.md)
  feels-like:
    name: Feels like
    source: |                     # as written: what it declares is read from it where it is imported
      import type { Celsius } from 'kraftverk';
      export function feelsLike(temp: Celsius): Celsius {
        return temp - 2;
      }

automations:
  start-charging-the-scooter:
    name: Start charging the scooter
    mode: watch                   # off · watch · act
    home: home                    # the home it is for: its clock, and its "home"; none, the family's
    uses:
      supply: garage-station.outlet.ac   # a device's key, and one of its parts
      charger: smart-plug                # a device alone is its main part
    do:
      - turn on: supply
      - wait until: charger reachable
        at most: 2 min
      - turn on: charger
      - make sure: charger.power > 50 W
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

**A script, where a step runs it.** `- run script: tidy-up.tidyUp`
names the script by its key and the step after a dot — its key alone when
it has one step — with no role to write under `uses`: the role is made as
`tidyUp: { script: tidy-up }` would make it, and an export writes it
back so. A role of its own is still written in full — a label of its own,
or a script whose functions a condition calls (`feel.feelsLike(…)`) needs
one: `uses: { feel: { script: feels-like } }`. Editors complete each
script's steps, and under `with` the step's inputs, each with its
default.

**A home's variables** (docs/PLAN-VARIABLES-AND-TRIGGERS.md). A home's
`variables:` are its own typed values, each by a key in camelCase: a
`toggle`, a `number` — in a `unit`, between a `min` and a `max`, in
`step`s — a `choice` of its `options`, `text`, a `time` of day, a
`counter` (whole, from nought unless it says its `min`), a `timer` (`for:` how long it runs; it holds its state — `idle`, `running`, `paused`, `ended` — and ends on its own). Each may say its
`title` — none: made from its key — a `description`, and what it `starts`
as. A kind alone is enough: `note: text`. The file says what each is, never
what it holds: that is the home's, set by its people, scripts and
automations, and kept across an import. One changed so what it holds no
longer fits goes back to what it starts as; one the file does not name is
left as it is.

**Spaces, places and labels** (docs/PLAN-WORLD-MODEL.md §8.5, §8.7, §8.13).
A home's `spaces:` are a tree under the home itself — buildings, floors,
rooms, areas, stairs, the outdoors — each by a key no other space of that
home has (`site` is the home itself, and taken); only a floor has a `level`
and an `elevation`. `openings:` join two spaces, or one and `outside` — the
site, `site`, is one too: a gate in the fence joins `site` and `outside`. A
device's `place:` names a home, perhaps a space of it — none: the home
itself — perhaps an `opening` it is at, and where in the space: `at`,
metres in its frame, a `height` above the floor and a `facing`; one that
moves says `based:` instead. A space may be drawn: its `outline`, its
corners in metres in its own `frame` — an origin and a turn within its
parent's, its parent's when it says none — and a floor its `plan`, a
drawing placed in the floor's frame. The site's frame is the home's: its
location and `bearing`, degrees from north. An opening's `shape` is where
in the wall it is. A home and a space may say their `icon`. Metres are
within a kilometre of their frame's origin, an outline or a shape at most
200 points, a drawing at most a metre a pixel, a turn any number of degrees
— kept from 0 to below 360: the same limits the app's screens keep
(`@kraftverk/map/limits`), so a file the API would refuse is refused as it
is read.
A drawing is a picture kept beside the file, as a home's is. `labels:` are the family's, each by key, and a device, a space or
an automation names the ones it has. An import writes spaces before the
devices standing in them, and adds or changes by key, never removing: a
space, an opening or a label the file does not have is left. A device
without `place:`, or with no `labels:`, is left where it is and as it is —
one device's YAML in the app says neither.

**People** (docs/PLAN-WORLD-MODEL.md §8.2, §8.3). Each by a key for the
file, with their id verbatim and their `chain` — who they are, as they
prove it, nothing private in it — beside what this family calls them,
their colour and their role, and their own `shortcuts`: automations by
key, in the order of their home page. A restore checks each chain again,
takes a newer one than the family has, and leaves out — or, not lenient,
refuses — one that does not check. Someone with no key of their own yet
is not written: they have nothing to prove.

## Rules in words

An automation's rule is written in words whose parse tree *is* the rule: what
the file says is exactly what the engine runs, the checker checks and the app
describes.

- **What starts it** (`when:`):
  - `at: "07:00"`, with `days: weekdays`, `weekends` or `[mon, fri]`
  - `every: 15 min`
  - `event: mains.lost` with `from: station`
  - `becomes: <condition>`, with `for: 2 min` (at most a week)
  - people and places, as presence says, as far as each shares:
    `arrives: someone` / `leaves: anna` with `at: home` (the run knows who
    as `run.who`); `first arrives: home` and `last leaves: home`, with
    `of: children` — the place going from nobody to somebody, and back
  - rooms, by what stands in them: `empties: bathroom` and
    `is occupied: hallway`, each with `for: 10 min` if you like
  - modes: `mode becomes: away` and `mode changes: day` (presence or day),
    with `at: cabin` for a home not the automation's own
  - any of them with `do: [steps]` of its own, which a run it starts takes
    in place of the automation's — "when the charge is below 20 %, turn
    the charger on; when it is 40 %, off", one automation — and with a
    name, `id: low`, which shared steps read back as `run.trigger` — and
    `at most every: 10 min`: a start it would make sooner than that after
    its last is let go
- **Only when** (`only if: <condition>`).
- **What it does** (`do:`), and what it does if a step does not succeed or it
  is stopped (`if a step fails:`):

  | Step | Says |
  |---|---|
  | `turn on: role` · `turn off: role` | switch a part |
  | `switch: role` + `on: <condition>` | on while the condition holds, off when it does not |
  | `send: command` + `to: role` + `capability:` + `with: {…}` | any command of a capability |
  | `set: role` + `setting: key` or `meaning: chargeLimit` + `to: <value>` | change a setting |
  | `wait: 5 s` | a pause |
  | `wait until: <condition>` + `at most: 2 min` | until it holds — every wait has its limit |
  | `wait for: mains.restored` + `from: role` + `at most: 30 min` | until the part says it |
  | `make sure: <condition>` + `within:` + `tries:` + `each time: [steps]` | retry until it holds |
  | `if: <condition>` + `then: [steps]` + `else: [steps]` | a choice |
  | `watch: <condition>` + `for: 5 s` + `if it stays so:` + `if not:` | watch, then choose |
  | `repeat: 3` + `do: [steps]` — and `until: <condition>` | round after round: so many times, or until it holds, at most that many |
  | `for each: charger` + `in: chargers` + `do: [steps]` — and `together: true` | the steps for each part of a group, `charger` within them — one after the other, or all at once |
  | `try: [steps]` + `if it fails: [steps]` | a step that does not succeed is answered, and the run goes on |
  | `stop: Already charged` — and `failed: true` | the run ends here, saying why |
  | `start: role` + `and wait: 10 min` | start another automation |
  | `remember: name` + `as: <value>` | remember a value for later runs |
  | `set mode: away` + `at: cabin` | put a home in a mode, as a person would |
  | `notify: everyone` + `title: "{run.who} is home"` + `text:` + `level: warning` | tell people, in their inbox and pushed; a value in braces said as it is then |

  Whatever it repeats, a run ends: at most 100 rounds a repeat, and 500
  steps a run.

- **Conditions and values** are expressions:
  - a reading: `role.meaning` — `charger.power`, `station.charge`;
  - `role reachable`;
  - of a place — a role a place fills, or `home` — what is so of it now:
    `home.people` (how many of the family are there), `bathroom.occupied`,
    `home.presence` and `home.day` (its mode on each axis, by key);
  - someone somewhere: `anna at home`, `any(p in children: p at school)`;
  - numbers with units — `50 W`, `15 %`, `30 min` — times of day `07:00`,
    `"text"`, `true`, `false`. A unit is one kraftverk knows
    (`packages/device-sdk/src/units.ts`: W, kW, Wh, kWh, %, °C, s, min, h …);
    any other is refused where it is written. A number keeps the unit it is
    written in, and is written back so; it meets a reading of the same
    dimension converted as it runs (`2 kW` beside a reading in W is
    2000 W), and one of another is a problem (`50 °C` beside W). A number
    with no unit is in the unit of what it is beside;
  - `< <= > >= == !=`, joined with `and`, `or`, `not`, and parentheses;
  - one of a list: `station.mode in ["eco", "boost"]`;
  - `time between 23:00 and 05:00` (across midnight when the end comes first);
  - `+ - * /` and `-x`: a product or quotient in the unit the two make — a
    power for a time an energy (`charger.power * 2 h`), a percentage a share
    of what it multiplies (`station.capacity * 50 %`);
  - one value or the other, `station.charge < 20 % ? 2 kW : 500 W`, and the
    first known, `outdoor.temperature ?? 10 °C`;
  - the language's functions: `min(a, b, …)`, `max(…)`, `clamp(x, low, high)`,
    `round(x)`, `round(x, digits)`, `floor(x)`, `ceil(x)`, `abs(x)`;
  - a reading over the time just gone, from what the home kept — of what a
    part reports, never of a place or a person:
    `average(station.charge, 1 h)`, `lowest(…)`, `highest(…)`,
    `change(station.charge, 30 min)` (how much it changed), `ago(…, 10 min)`
    (what it was then) — a minute to two weeks, a number or a setting;
  - something of each part of a group, taken together:
    `any(c in chargers: c.power > 10 W)`, `all(…)`, `count(…)`,
    `sum(c in chargers: c.power ?? 0 W)`, `average(…)`, `lowest(…)`,
    `highest(…)` — each part called by a name of its own within it;
  - how far a position a part reports is from the home (`home: location`), or
    from another part's: `distance(phone.position) < 500 m`,
    `distance(phone.position, car.position)` — in m, compared in any length;
    unknown until the home has a location;
  - the sun, where the home is (`home: location`): `sunrise`, `sunset`,
    `30 min before sunset` — a time of day, for `at:` and
    `time between sunset and sunrise`; unknown until the home has a location;
  - a recipe's setting: `setting.low`;
  - a package's function, by its id: `open-meteo.weather.skyLooks(forecast, cloudMax = 40)`.
- **Lengths of time**: `5 s`, `2 min`, `1 h` — always with their unit: a
  bare `15` would be seconds to a wait and minutes to `every`, so it is
  refused.
- **What fills a role** (`uses:`): `device-key` or `device-key.part`; for a
  group a `for each` goes through, a list of them —
  `chargers: [garage-plug, scooter-plug]`, in order, or
  `{ parts: [...], label: …, needs: […] }`; another automation as
  `{ automation: key }`. Who and where, of the family's world: a person
  `{ person: anna-example }`, some of them `{ people: [anna-example, …] }`
  — or everyone, `{ people: everyone }` — a home `{ home: cabin }`, a zone
  `{ zone: work }`, a space of the automation's home `{ space: bathroom }`
  — the one it is for, or the family's first; by the file's keys, so a home
  moved to another family reads as it should. A member with no key of their
  own yet — not in the file's `people:` — is named by their id. A role
  whose mode is read or waited for, or that a mode is set at, is a home.
  `home`, `someone` and `everyone` need no role: the automation's own home,
  anyone of the family, all of it. A role's label and what it needs come
  from what the rule does with it — the commands it is sent, the standard
  readings read from it (`charge` asks for a battery, `power` a
  power meter), the events it raises (`mains.lost`, an AC input); say them
  only when they differ:
  `{ part: …, label: …, needs: [switch, powerMeter] }`. A
  role the rule only changes a setting of, or asks only whether it can be
  reached, asks for no capability, and the language refuses a role any
  device would do: say its `needs`. (A file kraftverk writes always does.)
  The app names a role from its label — `switch`, `battery`, `switch2` —
  so what it builds reads as a file written by hand would.
- **Its settings** (`settings:`): each by its name, the value its rule runs
  with, read in the rule as `setting.low` — a level set in one place. Short
  when a value is all there is to say, long when it says more:

  ```yaml
  settings:
    lowFor: 2 min
    low:
      title: Start charging below
      value: 20 %
      min: 5 %
      max: 90 %
      step: 5 %
      slider: true
  when:
    - becomes: battery.charge < setting.low
      for: setting.lowFor
  ```

  A number keeps its unit — a length of time is kept in seconds, anything
  else in the unit its value is written in, its range converted to it; one
  of some options lists them, `options: { eco: Save power, boost: Charge fast }`.
  An automation copied from a recipe keeps the recipe's settings, at the
  values its owner chose; the app sets them with a slider each.
- **What it may be given, and what it answers** (`inputs:`, `result:`):
  an automation as a function. Its inputs are written as settings are,
  each the value a run takes when not given, and read as `given.level`;
  its result is one field, the kind it answers, given by an `answer` step.
  Another automation's `start` gives it values and keeps its answer:

  ```yaml
  start: charge
  with: { level: 90 % }
  and wait: 1 h
  remember as: reached        # one of what this automation remembers
  ```

  What it is given, and what is remembered, are held to its inputs and
  result as soon as both automations are known.
- **Started again while it runs** (`while running:`): what one of its
  triggers starting it while a run still takes its steps does — `skip`, the
  start is let go (as when none is written); `restart`, the run is stopped,
  as you would, its `if a step fails` steps taken, and it starts afresh;
  `queue`, it starts again once the run ends, at most 10 waiting.
- **What it remembers** (`memory:`): written as its settings are, each the
  value it starts from; read as `memory.timesCharged`, set by a `remember`
  step:

  ```yaml
  memory:
    timesCharged: { value: 0, integer: true, min: 0 }
    lastPower: 0 W
  when:
    - event: mains.lost
      from: station
  do:
    - remember: timesCharged
      as: memory.timesCharged + 1
    - remember: lastPower
      as: charger.power
  ```

  What a run remembers is converted to its unit and held to its range, and
  kept by kraftverk, not in this file: across runs, restarts and changes to
  the automation. A value its field no longer takes reads as the one it
  starts from. A database set aside starts it afresh.

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

## One device, one automation

A file need not be a whole home. One device's or one automation's own YAML —
what its page shows, with no `kraftverk:` around it — imports as a file of
that one, under a key made from its name (`readConfig`'s `holds`; the
plan says so, and that the one you have by that key is changed to it). An
export of one device or one automation is a whole file of just it, and
imports anywhere; an automation's names the devices it uses, which the server
it goes to must have — or be given one of its own for each.

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
  is as configuration, its secrets by name only; and an export of it alone,
  made where it is — its secrets left out, sealed, or plain if allowed.
  **Add a device → From a configuration** imports one: a file exported from
  here or another server, or its own YAML as its page shows it.
  Under **Connections**, a server-held way with secrets says whether they may
  leave in plain text — off unless chosen, turning it on warned against —
  and adding a device asks the same, off.
- **An automation's page → Configuration**: its key; what it is as
  configuration, to read and to learn the language from what you built;
  **Edit as YAML**; and an export of it alone, made where it is. **New
  automation → As YAML** writes one from nothing — or from a file of one
  automation pasted in, which is made under the key the file gives it. Its form writes it either way
  — **Form** or **YAML** at the top — the same draft: a change in its YAML
  is read back into the form as soon as it reads right, and saved as the
  form saves it, letting it act asked first. Its YAML may say what the form
  does not: its mode, clock, keeping it so. A
  role nothing fills yet is written empty (`plug: ~`).

The editor in a browser is CodeMirror with its YAML language: the JSON Schema
— made in the app from the vocabulary — completes keys, values and your
devices' keys and parts, and explains them on hover
(`codemirror-json-schema`; its tooltips without the code highlighter it
would load, `client/metro.config.js`). Every problem — the YAML's own, the
document's, what it means — is found by `packages/home-file`, the same code
the server checks with, marked where it is and listed under it. A phone's
own app writes it in a text field, its problems listed the same.

## Versions

The configuration is the one thing in kraftverk versioned on purpose
(AGENTS.md). `kraftverk: n` at the top says which version wrote it; each
change to the document's shape adds a migration from n to n + 1
(`packages/home-file/src/migrate.ts`) with a kept fixture of version n, so every
newer kraftverk reads every older file. A file from a newer kraftverk is
refused, saying so.

The fixtures are in `packages/home-file/fixtures/` (`v1.yaml`, and one for each version after), never changed once
kept; `migrate.test.ts` fails while a version lacks its fixture, a version
below this one lacks its migration, or any fixture does not read — with
nothing wrong — and write back the same.

| Version | What changed |
| --- | --- |
| 1 | The first |
| 2 | Each standard meaning is one word: `station.battery.soc` is `station.charge`, `charger.power.draw` is `charger.power`, `meaning: battery.chargeLimit` is `meaning: chargeLimit` |
| 3 | A role under `uses` has no `description`: what a recipe says for whoever fills a role stays with the recipe |
| 4 | A setting is `setting.low`, not `$low`; a package's function is called by its id alone, without `call` |
| 5 | A way may go `through` another device — an account, a gateway — named by its key, its address then its key there. Nothing older says so, so nothing changes |
| 6 | The document's shape is as in 5; an integration's own entries changed, as its migrations say: a NIU scooter is reached through its NIU account, a device of its own |
| 7 | As 6; a Zigbee socket is reached through its Tuya gateway, a device of its own (Tuya's migration): one gateway entry per gateway address, its key the one the sockets had, and each socket `via: gateway` by its Zigbee address |
| 8 | A device may say it is `paused: true`: kept, and not reached, until resumed. Nothing older says so, so nothing changes |
| 9 | A device may say how long where it has been is kept: `track: 30 days`, 1 to 366. Where it was is never in the file. Nothing older says so, so nothing changes |
| 10 | A family and its homes (docs/PLAN-WORLD-MODEL.md): `family:` (name, kind, locale) and `homes:`, each by key with its name, type, location and geofence, time zone, address, country and policy. An automation may say the `home:` it is for, and `clock:` only for a clock of its own. Version 9's `home:` becomes the first home, `home`; an automation that said no clock keeps the home's. Added since, with nothing to migrate — every version-10 file reads as it did: a home's `spaces:` and `openings:`, a device's `place:` or `based:`, and `labels:`; `people:` |
| 11 | Shortcuts are each person's own: `shortcuts:` under a person, automations by key in order. An automation has no `home page:`; version 10's become every person's shortcuts, in their places — a file with no people keeps none |
| 12 | The family's zones (`zones:`, each by key with its name and location), who a device is with (a device's `people:` — carries, drives, owns, uses — by the people's keys) and what a person shares (`sharing: { level, keep }`). Nothing older says them, so nothing changes |
| 13 | Geometry: a space's `frame`, `outline` and — a floor's — `plan`; an opening's `shape`; where in a space a device stands (`at`, `height`, `facing`). Nothing older says them, so nothing changes |
| 14 | The family's own modes (`modes:`, each by key with its `axis` — presence or day — its name and icon). The built-in ones are every family's and never written; which mode a home is in is not the file's. Nothing older says them, so nothing changes |
| 15 | Automations of people and places: a role under `uses` may be filled by a person, people, everyone, a home, a zone or a space — `{ person: key }`, `{ people: [keys] }`, `{ people: everyone }`, `{ home: key }`, `{ zone: key }`, `{ space: key }` — and the language has their triggers, `set mode` and `notify`. Nothing older says them, so nothing changes |
| 16 | A home's `bearing` and `icon`, a space's `icon`, and an opening that joins a space — or the outside — to `site`, the home itself. Nothing older says them, so nothing changes |
| 17 | The family's scripts in TypeScript (`scripts:`, each by key with its `name` and its `source` as written, docs/PLAN-SCRIPTS.md). An import reads each with the engine where it is imported: one that does not read is a problem at its key — a restore keeps it as it is, and says so. Nothing older says them, so nothing changes |
| 18 | Automations run scripts: a role under `uses` may be filled by one of the family's scripts (`{ script: key }`), run by a `run script:` step and its functions called in an expression (`feel.feelsLike(…)`); and an automation that acts says who it acts for (`acts for:`, a person by key) — what its scripts do, they do for them. Nothing older says them, so nothing changes |
| 19 | A home's variables (`variables:`, each by key with its `kind` and perhaps its `title`, `description`, what it `starts` as, a number's `unit`, `min`, `max` and `step`, a choice's `options`; docs/PLAN-VARIABLES-AND-TRIGGERS.md), read by an automation as `home.var.key` and changed by its `set variable:` and `count:` steps. Nothing older says them, so nothing changes |
| 20 | More that starts an automation (docs/PLAN-VARIABLES-AND-TRIGGERS.md §3): `on start: 1 min`, once as kraftverk starts; `changes:` a reading or a variable — with `from`, `to`, `by at least`, and `run.from`, `run.to` in its run; an `at` time from a home's time variable (`at: home.var.wake`); and an `at` only in `months` or on `dates` (`"12-01..12-24"`). `every` may be every minute. Nothing older says them, so nothing changes |
| 21 | A home's timers: a variable of `kind: timer`, with `for:` how long it runs when started without saying; started and stopped by `start timer:` (with `for:`) and `stop timer:`, and read as its state — `idle`, `running`, `paused`, `ended`. Nothing older says them, so nothing changes |

**An integration's own entries.** A change to what a type is reached by —
a way it no longer has — is not the document's shape, but a home kept
before it must come back after it all the same. So an integration may name
its file migrations (`kraftverk.integration.migrations`, each a
`FileMigration` from the SDK): each takes the document from one version to
the next after the core's own step, and finds its entries by what is
installed — the types reached through its account — never by a product's
name. The version line is still the core's: a version that only an
integration's entries changed in is a version all the same, with its fixture
here, and the integration keeps its own test of the change.

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
problem, not a change. What fills each role is checked in the plan as the
apply checks it — the part is there, can do what the role needs, and
reports and lets be written what the rule asks — so nothing is said only
after the yes. An automation bound to a device you removed is exported with
that role empty, and said: a file names no key the server does not list. A device you removed — the same type, by its identity
or its key — is **brought back with its history**, not added beside it. An
app's own ways to reach a device are not in a configuration: its keys live
on the phone.

## Restoring after a reset

When the server starts on a database it has just made — a new schema set the
old one aside, or there was none — and a configuration is kept beside it,
it restores from it before anything is written over it: the file is copied
aside first (`kraftverk.before-<time>.yaml`, the last five kept), then
imported as a merge that asks nothing — its secrets are the server's own,
and what acted acts again. It restores **item by item**, each in a
savepoint of its own: a device it cannot read or keep (a type no longer
installed) is left out; an automation it cannot keep as it was — a role
naming a device that is not there, a part that can no longer do what it
needs — is kept **turned off**, its rule whole and what still fills it,
for its owner to finish; everything else is restored. A secret the server's
key no longer opens leaves its device restored without it, to be given
again. Each is said. What happened is on the
timeline (`config.restored`, or `config.restore-failed` with its
problems), in the server's log, and in `GET /api/config/snapshot`'s
`restored`. Accounts are never in a configuration. A database set aside
for a new schema hands them straight to the new one, and everyone signs in
again with the same password ([SECURITY.md](SECURITY.md#where-accounts-live)).

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
  secrets: none | sealed | plain, passphrase?, yourPassword? }` →
  `{ text, notes }`: the file, and what could not go in. One that carries
  secrets — sealed or plain — asks for your account's password
  (`yourPassword`): a borrowed session carries off no key. An export that
  carries secrets is on the timeline.
- `POST /config/plan` — `{ text, mode: merge | replace, passphrase? }` → the
  plan (`ImportPlan`): `id` (null when its problems stop it), `problems` with
  lines, `devices`, `links`, `automations`, `policy`, `needs`, `notes`. In
  the app, `{ from: this-node | copy }` plans a home it keeps beside the one
  it shows — its own, moving to its server; or the copy of its server's,
  kept — and `GET /config/elsewhere` says what such a home has; a server's
  home keeps neither, and says none (docs/PLAN-SHARED-CORE.md, 6h).
- `POST /config/apply` — `{ plan, include?: { devices?, automations? },
  secrets?: { "device.field": value }, rebind?: { "automation.role":
  "device-key.part" }, confirmation? }` → what it did (`ImportApplied`); a
  409 with `needsConfirmation` first when it sets something acting or
  removes; 400 with `problems` when it cannot be applied.
- `GET /config/snapshot` — the snapshot's path, when it was last written,
  and what restoring it last did.
