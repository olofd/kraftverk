# kraftverk as a product

What kraftverk is for, where it stands next to Home Assistant, and the plan
for making it a product people choose. [`ARCHITECTURE.md`](ARCHITECTURE.md)
is how it is built; this is why, and what comes next. Written 2026-09-29.

## 1. What it is

**A small home hub where every device gets first-class support, written as
code** — reverse-engineered gear and things you built yourself. Local, safe
with hardware that can break, pleasant to use, and easy to extend. It runs on
its own, and it should also make every device it supports show up in Home
Assistant.

### The bet: code is cheap now

Home Assistant was designed when writing an integration was expensive. So it
made the common case configurable — generic entities, device classes, YAML,
dashboards people assemble — and let a device be as good as the standard it
fits into.

With AI coding agents, that cost has collapsed. A screen made for one product,
a precise settings schema with the product's real limits, a protocol nobody
documented, a register map read out of a vendor app: work that took weeks
takes an afternoon. So kraftverk bets the other way — **more code, less
configuration**:

- **The device owner builds the integration**, as deep as they want: its own
  dashboard, settings grouped the way the product works, its own safety rules,
  its own automation options. First-class support for every device, rather
  than every device reduced to what a standard can say about it.
- **Standards are the floor, packages the ceiling.** A device speaking a
  standard should need no code, and kraftverk is bound to support more
  standards over time — out to Home Assistant, in from BTHome, ESPHome,
  Shelly. But a standard is where support starts, not where it stops.
- **Cheap code needs strong rails.** What makes code an agent wrote safe to
  run against a battery is what surrounds it: a typed contract, a simulator
  and contract test per package, the architecture check, and one gateway every
  physical action passes. Those rails are the product as much as the app is.

It began as an app for one power station. What it has become is more general
than that, and better than its README said:

- **Every device is a package** with a declarative, typed contract: what it
  measures, what it can do, its settings schema, how it is reached. The app
  draws a device it has never seen from that alone.
- **Every physical action goes through one gateway** — schema-checked,
  confirmed by a person when dangerous (never by an automation), read back to
  verify, and written to a timeline.
- **The same code runs in the server and in the app.** A browser or phone can
  hold a Bluetooth device itself, with no server at all.
- **It is built for bringing up hardware nobody documented**: simulators for
  every type, register dumps, snapshot/diff, frame logs, raw frames behind the
  protocol's guard.

## 2. Honestly: where it stands

What is genuinely good, and rare:

- The architecture. Layers that hold (transport → protocol → device type),
  checked on every push; one API contract; one holder core; one gateway.
- The safety model. Nothing in Home Assistant compares for devices where a
  wrong write is a dead €1000 battery.
- History that lasts (raw 14 days, hourly for 2 years), sign-in everywhere,
  secrets sealed at rest, 490+ tests.

What holds it back, in order of how much:

1. **One verified device.** A framework with one real device reads as a P280
   app with a nice architecture. The framework claim becomes credible at three
   to five reference devices across different transports.
2. **Getting it running needs a clone, npm and a long read.** Home Assistant's
   strongest feature is not its integrations; it is that you flash a card and
   it runs. There are no published images, and a server is three containers.
3. **Extending it needs a fork.** Device types are found in the repository;
   the app's registry is generated at build time. Nobody can publish a device
   type and have others install it.
4. **You cannot try it before installing it.** For a project whose app runs
   in a browser with no server, that is a missed open door.
5. **The words.** Internal vocabulary — holders, connection methods, links —
   reached the user-facing docs, and the docs are long prose. The front door
   has to be scannable.
6. **Automations are one recipe.** Fine: recipes are the right shape. But one
   is a demo, not a feature.
7. **Store builds do not exist**, and a phone reaches Bluetooth only through a
   development build.

**The pivot, and a caution.** "A small Home Assistant alternative" is the
right *direction* and the wrong *pitch*. The difference is the bet above —
code-first, per device — not a smaller copy of the same thing. Most people who own a reverse-
engineered power station already run Home Assistant, and asking them to
replace it is asking a lot. Asking them to *add* kraftverk for the devices
Home Assistant handles badly — and have those devices appear in Home
Assistant anyway — is asking very little. Stand-alone for people without it;
a good neighbour for everyone else. Everything below follows from that.

The scope trap: becoming Home Assistant-shaped means dashboards, voice,
cameras, Zigbee, scripting, a thousand cloud integrations. Each is a product.
kraftverk wins by **not** building those (§5).

## 3. Next to Home Assistant

### The data models line up closely

| kraftverk | Home Assistant | How well |
| --- | --- | --- |
| Device: `identity`, brand, model, firmware | Device registry: `identifiers`, `manufacturer`, `model`, `sw_version` | 1:1 — `identity` becomes `["kraftverk", identity]`, a MAC also a `connection` |
| Telemetry `MetricSpec`: key, unit, `kind`, standard `metric`, state class | `sensor` / `binary_sensor`: `device_class`, `unit_of_measurement`, `state_class` | Close — `kind` maps to `device_class` (power, energy, voltage, current, temperature, frequency, duration, battery); state classes are Home Assistant's own three; `state` to a `binary_sensor` — all in `device-sdk/src/standards.ts` |
| Controls: `switch` / `enum` / `number` / `button` | `switch` / `select` / `number` / `button` entities | 1:1 |
| Settings schema | Entities with `entity_category: config` | Close — except dangerous fields, which stay in kraftverk (a person must confirm there) |
| Health: `connected` / `offline` / … | Availability | 1:1 as `online` / `offline` |
| Advanced tools | `entity_category: diagnostic` | Partly — dumps and raw frames stay in kraftverk |
| Capabilities: `switch`, `battery`, `outlets`, `powerMeter`, `acInput` | No equivalent; entities are flat | kraftverk's is richer. An outlet becomes a switch plus a power sensor |
| History: raw 14 days, hourly min/avg/max for 2 years | Recorder, and long-term statistics: hourly mean/min/max | The same design, arrived at independently |
| Setup steps: form, discover, action, check | Config flow | Similar shape; not bridged — devices are added in kraftverk |
| Links: this plug `feeds` that station | `via_device`, only for hubs | kraftverk's is richer; stays in kraftverk |
| Recipes, observe then arm | Automations and blueprints | Different on purpose; not bridged |
| Power only | The Energy dashboard wants kWh, `total_increasing` | A gap: kraftverk should derive energy counters from power (useful on its own too) |

### Three ways to be supported in Home Assistant

| Route | What it is | Size | Verdict |
| --- | --- | --- | --- |
| **MQTT discovery bridge** | The server publishes Home Assistant's discovery messages for each device and its states, and takes commands back through the gateway, as actor `home-assistant`, audited | **S–M**: one server module, a settings screen, tests | **Do this.** No Python. Every device type — including ones not yet written — appears automatically, because it is derived from the declarative contract |
| Custom integration (HACS) | A Python integration talking to kraftverk's API | M–L, and a second language to maintain for ever | Only if MQTT turns out to be a real barrier |
| Port device types to Home Assistant | Rewrite each protocol in Python as a native integration | L per device | No — it gives up the SDK, which is the product |

So: **no, it is not a huge amount of work.** The declarative contract does
almost all of it. What does not cross the bridge is deliberate — dangerous
settings, the reverse-engineering tools, recipes, setup — and it is exactly
what kraftverk is for.

Two smaller pieces complete the picture:

- **A Home Assistant add-on** — a repository with a `config.yaml` pointing at
  kraftverk's published image. That is how people running Home Assistant OS
  install anything. Small, once there is an image.
- **Later, the other way round**: Home Assistant as a service kraftverk adds,
  so a recipe can use a temperature or an electricity price Home Assistant
  already has.

## 4. How it is better than Home Assistant

Not in breadth — never in breadth. In these:

| | Home Assistant | kraftverk |
| --- | --- | --- |
| **The idea** | Configuration: fit each device to a standard's entities | Code: each device gets a package made for it |
| **Adding support for a product** | A Python integration: config entries, coordinators, entity platforms, and a long review queue | One TypeScript package from a template, with a simulator and a contract test on day one |
| **What you see** | Entities, and dashboards you build | Device pages drawn from the type; a custom screen only when it earns one |
| **Risky writes** | A service call | Validated, confirmed by a person, verified by reading back, on a timeline |
| **Your phone** | A remote control | Can hold the device itself, over Bluetooth, with no server |
| **Trying it** | Install it first | Open a page *(planned, §6 E)* |
| **Automations** | Anything, in YAML or a rule builder | Recipes that watch first and act only once armed |
| **Unknown hardware** | Bring your own tools | A workbench: dumps, diffs, frame logs, simulators |

## 5. What it will not do

Zigbee, Z-Wave, Matter and Thread (use Home Assistant or Zigbee2MQTT) ·
cloud-only devices · cameras, media and voice · a dashboard editor · a
scripting language. Saying so plainly is part of the product: it tells people
in one glance whether kraftverk is for them.

## 6. The plan

Each phase ships on its own. Sizes as in ARCHITECTURE.md §8.

### A — The front door (S)
- ✅ The README as a front door: what it is, what it supports and does not,
  one way to start; the station's details with the station
  (`packages/devices/aferiy-p280/README.md`), running in `RUNNING.md`, the API
  in `API.md`.
- Fresh screenshots of the device-first app, and a short demo GIF.
- The supported-devices table generated from each package's `meta`
  (`npm run gen:docs`), so it cannot drift from the code.
- `CONTRIBUTING.md`, and issue forms: *Support my device*, *My model differs*.
- The repository's description and topics about the hub, not the station.

**Done when** someone landing on the repository knows in thirty seconds what
it is, whether their device is supported, and how to start.

### B — Easy to run (M)
- Multi-arch images (amd64, arm64) published to GHCR from GitHub on a version
  tag; releases with a changelog. Nothing about any deployment published.
- A `compose.yaml` that pulls instead of builds; one container by default,
  the broker a process inside it that keeps its separate life as an option.
- First run entirely in the app: create the account, add a first device or a
  simulated one.
- The Home Assistant add-on repository.

**Done when** a Raspberry Pi or a NAS goes from nothing to the app in two
commands, without cloning anything.

### C — A good neighbour to Home Assistant (S–M)
- The MQTT discovery bridge (§3), off until switched on, per device.
- Energy counters derived from power, so Home Assistant's Energy dashboard
  accepts kraftverk devices.

**Done when** adding a device in kraftverk makes it appear in Home Assistant
with the right device classes, and switching it there goes through the
gateway and onto kraftverk's timeline.

### D — A framework people can join (L)
Built on the data model of [ARCHITECTURE.md](ARCHITECTURE.md) §8 steps
23–32 — parts, descriptions that come from the device, events, refinement, a
shared vocabulary with Home Assistant and Matter — which comes first.

- `@kraftverk/device-sdk` on npm, and `npm create kraftverk-device`.
- **Packages bring their own automation options**: a device type ships the
  recipes that make sense for it (a station's reserve, a heater's cheap hours),
  run by the same engine and gateway as the core's.
- **Bring your own packages, build your own image**: one command builds the
  server and the app with the packages you added, so a device's own screens
  need no fork — code-first has to mean easy to build.
- **Writing a device with an agent** is a documented path: an `AGENTS.md`
  for device packages — the contract, the rules the check enforces, how to
  capture evidence from real hardware — so a coding agent gets it right first.
- The server loads device packages from a folder or npm, not only the
  repository; the app shows types it was not built with through the generic
  screens (architecture step 20's degrade path).
- The workbench made generic: frame log, snapshot/diff and raw frames for any
  protocol that offers them, not only the station's.
- Standards, as packages like any other (the floor):
  - **BTHome** — the open BLE advertisement format: passive, cheap sensors,
    and a listen-only transport;
  - **Shelly Gen2+** — the local RPC API, found by mDNS;
  - **ESPHome's native API** — the door to everything people build.
- And a second deep one (the ceiling): **a BLE battery BMS** (JBD or JK) —
  reverse-engineered, with its own screens, and the solar DIY crowd this is
  for.
- A device index on the site, from each package's `meta`.
- Longer term, more standards in and out as they earn it — Matter as a bridge
  is the obvious one.

**Done when** someone outside the repository writes, runs and shares a device
type without forking.

### E — The experience (M, ongoing)
- **Try it now**: the app built for GitHub Pages in local mode, with
  simulated devices running in the browser — and, over Web Bluetooth, a real
  device reached from the page itself. Nothing else in this space can do that.
- A recipe library, each one observing before it is armed.
- A timeline that answers "what happened, and why".
- Notifications (ntfy, web push).
- Store builds, after architecture step 20; accessibility, step 22.

### The site
GitHub Pages, built from `docs/` (VitePress): a landing page — what it is,
the device grid, the comparison — the documentation, and **Try it now**
(phase E). Built and published by GitHub Actions, like CI.

## 7. The order

**A → B → C**, then D and E side by side. A makes it understandable; B makes
it installable; C gives the people most likely to want it — Home Assistant
users with a power station — a reason to install it today. D is what makes it
a framework rather than a claim, and it is the longest.
