# Devices, and wiring them together

Design for the next layer: one list of the things you own, a screen per thing, and a way to
connect them that feels like assembling Lego rather than programming.

Reading order: [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md) for the product goal,
[`PLUGIN-ARCHITECTURE.md`](PLUGIN-ARCHITECTURE.md) for the extension system this builds on.

Status: the device catalog, CRUD, model selection and history sampling are **built on the
server**; the app's device grid and detail screens are next. The end goal this serves is
summarised in [`PROJECT-BRIEF.md`](PROJECT-BRIEF.md#the-end-goal-devices-you-own-wired-together).

### Devices are added, not detected

A device exists because you added it, and it is stored in the database — so it survives a
refresh, a restart, and being unplugged for a week. The catalog holds its type, **model**,
driver, name and configuration; the registry joins those records to whatever is currently
answering. An unreachable device stays in the list, greyed and honest, with its history
intact.

The model matters and is chosen when adding: the register map differs between a P280 and an
F2400, and the picker marks which models are verified rather than implying they are equal.

Full CRUD is part of the design, not an afterthought: rename, remove (with a warning naming
what is lost, including automations that reference it), and a reset to a blank slate — a
setup you cannot undo is one people are afraid to try.

### Each device brings its own UI

The P280's dashboard, settings and protocol screens are *P280 UI*, not app UI, and belong in
a device package alongside the Tuya plug's panel. The app becomes a shell that renders the
device list, the wiring and the generics — schema forms, charts, health, setup wizards —
that every device gets for free. See the brief for the rules that keep this from becoming a
loophole.

---

## 1. The problem with what exists

Today the app has two mental models bolted together:

- **Devices** means "which power station am I bound to, over which transport".
- **Extensions** means "which driver packages are installed and configured".

Neither is how anyone thinks about their home. You do not own *an extension*; you own **a power
station and a smart plug**, and you want to see both, look at what each is doing, and tell one to
react to the other.

The fix is a third noun the app does not have yet: a **device**.

```
plugin  = a driver          "Tuya (local)"        installed once
device  = a thing you own   "Hallway plug"        added, named, wired
```

One plugin can provide many devices — a Home Assistant driver will expose dozens — and the core
provides one without any plugin at all: the power station. Making the station just another device
is what stops it being a special case forever.

---

## 2. The device model

A device is an identity, some things it measures, some things it can be told to do, and where it
came from.

```ts
export type DeviceDescriptor = {
  /** Stable and namespaced: "tuya:bf8dc9…", "station:AC276E629BEA". */
  id: string;
  /** Vendor name, overridden by whatever the user renames it to. */
  name: string;
  kind: 'power-station' | 'smart-plug' | 'meter' | 'sensor' | 'service';
  icon: string;
  /** Which plugin provides it. Absent for the built-in station. */
  providedBy?: string;
  measurements: MeasurementSpec[];
  controls: ControlSpec[];
  /** Fresh state, and how old it is. */
  read(): Promise<Reading[]>;
};
```

### Measurements — what makes charts generic

```ts
export type MeasurementSpec = {
  key: string;            // 'watts'
  label: string;          // 'Power'
  unit: string;           // 'W'
  kind: 'power' | 'energy' | 'percent' | 'voltage' | 'current' | 'temperature' | 'frequency' | 'state';
  precision?: number;
  /** Counters like kWh chart as deltas, not as a rising line. */
  cumulative?: boolean;
  /** The one shown on the device's card. */
  primary?: boolean;
};

export type Reading = { key: string; value: number | boolean; at: string };
```

This single declaration is what answers "I want to see how many watts the plug is drawing":
history samples every measurement any device publishes, and one chart component renders any of
them, choosing its presentation from `kind`. Nobody writes a Tuya chart.

### Controls — what makes wiring generic

```ts
export type ControlSpec = {
  id: string;                   // 'relay'
  label: string;                // 'Grid relay'
  kind: 'switch' | 'enum' | 'number' | 'button';
  /** The permission it needs. Actuators require a grant and confirmation. */
  capability: CapabilityName;
  dangerous?: boolean;
  options?: { value: string; label: string }[];
  min?: number; max?: number; unit?: string;
};
```

A device *declaring* its controls is what lets the app answer the question the user actually
asked — **"what can this plug do, and what should it react to?"** — without knowing what a plug
is. The same list drives the buttons on the device screen and the actions offered in the rule
builder.

Triggers are derived, not declared: a numeric measurement yields *rises above / drops below /
changes by*, a `state` measurement yields *turns on / turns off*, and the core adds *at a time of
day* and *for a sustained period*. Deriving them means a new device is immediately usable in
automations with no extra work.

---

## 3. Devices tab: the home for things you own

A responsive grid of cards — two columns on a phone, more on a desktop — grouped by kind:

```
POWER STATION
┌────────────────────────────┐
│ ⚡ Aferiy P280             │
│ 87 %          ▁▂▃▅▆▇      │   ← primary measurement + 24 h sparkline
│ ● live · 4 s ago           │
└────────────────────────────┘

PLUGS & METERS
┌────────────────────────────┐  ┌────────────────────────────┐
│ 🔌 Hallway plug            │  │            +               │
│ 243 W         ▁▁▂▅▂▁      │  │      Add a device          │
│ ● live · 6 s ago           │  │                            │
└────────────────────────────┘  └────────────────────────────┘
```

- **The card shows one number**, chosen by the device (`primary`), plus a sparkline and a
  freshness age. Never a green dot over stale data.
- **"Add a device" is a card in the grid**, not a menu item, because adding is the second thing
  anyone wants to do.
- Groups appear only when non-empty; a fresh install shows the station and the add card.

### Add a device

Tapping **+** lists what the installed drivers can provide, then runs that plugin's existing setup
wizard — the one already built. A driver that is not installed appears greyed with what it needs.

This is the important reframing: **Extensions stops being a destination**. It becomes "manage
drivers", reachable from Settings for people who care about packages. Everyone else adds a device.

### Device detail

One screen per device, the same sections for all of them, each hidden when empty:

| Section | Contents |
| --- | --- |
| **Now** | Every measurement as a live readout, with units and age |
| **History** | 24 h chart; tap a measurement to switch series; range picker; CSV export |
| **Controls** | Rendered from `controls`; actuators need a grant and a two-step confirm |
| **Automations** | *"Used by: Backup reserve"* — what breaks if you remove this |
| **Settings** | The plugin's `ConfigSchema` form; rename; remove |
| **Connection** | For the station: transport choice (server MQTT / server BLE / direct), which is where the current Devices tab's job moves to |
| **Advanced** | Register dumps for the station; datapoint dumps for a Tuya plug |

"Used by" matters more than it sounds: a device silently wired into an automation is exactly the
thing you must not delete by accident.

---

## 4. Wiring: Lego with typed studs

The dangerous version of this feature is a free-form rule engine. This project cuts mains to a
battery system; "make it programmable" and "make it safe" pull against each other, so the design
separates them into two tiers.

### Tier 1 — Recipes (curated, parameterised, the default)

A recipe is a whole behaviour the core implements, with **roles** you fill with devices:

```
Backup reserve
  roles     station    ← needs battery.read + ac-input.read     [ Aferiy P280 ▾ ]
            gridRelay  ← needs gridRelay.switch                 [ Hallway plug ▾ ]
  settings  reserve 30 %   hard floor 15 %   start at 40 %
  state     OBSERVE — would have cut mains 12 minutes ago
```

The dropdowns only offer devices whose capabilities satisfy the role. That is the "typed studs"
idea: **an incompatible piece cannot be connected**, so the failure mode is a role you cannot
fill, not an automation that misbehaves at 3am.

Every guard from the brief — dwell, hysteresis, freshness, hard floor, two-stage verification,
`GRID_UNAVAILABLE`, the arming checklist — lives inside the recipe, in core, not in user
configuration. The reserve controller is recipe #1. Later: *charge overnight when tomorrow is
cloudy*, *avoid the expensive hours*.

### Tier 2 — Rules (open, but on rails)

For everything the recipes do not cover, one sentence:

```
WHEN   [Hallway plug ▾] [power rises above ▾] [ 2000 W ]  for [ 60 s ]
AND    [Aferiy P280 ▾]  [battery is above ▾]  [ 50 % ]
THEN   [Hallway plug ▾] [turn off ▾]
       because "stop the kettle draining the pack"
```

Built from the same declarations: the first dropdown lists devices, the second their measurements
and derived triggers, the last their controls. A phone-friendly sentence builder, not a node
graph — node graphs demo well and are miserable to use on a 6-inch screen.

**What keeps this safe is that a rule has no more power than you do.** Its action goes through the
same [action gateway](PLUGIN-ARCHITECTURE.md#5-the-action-gateway--serversrcactions): the grant
must exist, dwell and freshness still apply, the physical effect is still verified in two stages,
and everything lands in the audit timeline. A rule cannot reach a device it was not granted, and
a rule that would breach the reserve or the hard floor is refused **at execution**, with the
reason shown against the rule.

Rules start in **dry run**, logging what they would have done. Arming one is a deliberate act,
and arming one that touches mains needs the same checklist as the controller.

### Why not just Home Assistant?

Because a HA automation cannot know that this station's AC input must come back before the pack
hits its floor, and cannot verify that the mains actually returned. The recipes encode knowledge
that lives in `P280-FINDINGS.md`. The rules exist so the 10 % HA would have covered is not a
reason to run two systems. Both remain optional; the station works with neither.

---

## 5. What this changes underneath

| Area | Change |
| --- | --- |
| SDK | `DeviceDescriptor`, `MeasurementSpec`, `ControlSpec`, `Reading`; plugins gain `devices()` |
| Station | A core adapter presenting the station as a device — same shape as any plugin's |
| Server | A device registry merging core + plugin devices; `GET /api/devices` returns it |
| History | Samples keyed by `(deviceId, measurement)` rather than station-specific columns |
| Automations | Recipe host + rule engine, both executing only through the action gateway |
| App | Devices grid, device detail, chart component, recipe/rule builders |

**Naming collision to resolve first:** today's `GET /api/devices` means "stations discovered by
the current transport". That becomes `GET /api/station/transports`, and the new meaning takes the
good name. Worth doing early, while there is one consumer.

---

## 6. Order of work

Each stage is useful on its own, which matters more than the total.

| # | Stage | Worth having even if the next never ships |
| --- | --- | --- |
| 1 | Device model in the SDK; Tuya plug and station both expose devices; `/api/devices` | One honest list of what you own |
| 2 | Devices grid + device detail with live readings and controls | Look at the plug, switch it, without the Extensions screen |
| 3 | History per measurement + the chart component | **"How many watts is it drawing"** — answered for every device at once |
| 4 | Add-device flow; Extensions demoted to driver management | Adding a plug stops requiring a mental model of plugins |
| 5 | Recipe host + Backup reserve, in OBSERVE | The reserve feature, watchable before it is trusted |
| 6 | Arming gate (needs API auth) | The recipe may finally act |
| 7 | Rule builder, dry-run first | The long tail, without a second automation system |

Stage 3 is where the user-visible payoff concentrates: the moment measurements are generic, every
device gets charts, and the P280's own history arrives with them rather than as separate work.

---

## 7. Risks worth stating

- **Rules are the sharp edge.** Mitigated by: gateway-only actions, dry run by default, policy
  re-checked at execution, and recipes covering the cases that matter so most people never write
  a rule.
- **A device list implies device management** — renaming, removal, "what breaks if I delete
  this". Cheap to design in now, expensive to retrofit.
- **Charts invite dashboards.** The Dashboard stays station-first; per-device charts live on
  device screens. Resist a general-purpose dashboard builder.
- **The station is not quite like a plug.** It has settings with safety rules, four ports, and a
  protocol screen. The adapter should expose what generalises and let the station keep its own
  screens for what does not — forcing everything through one shape would make both worse.
