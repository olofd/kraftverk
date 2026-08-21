# Extensions, and the grid relay that is their first consumer

> **Current implementation authority:** read
> [`DEVICE-FIRST-REFACTOR.md`](DEVICE-FIRST-REFACTOR.md) first. In particular,
> plugin-wide configuration and `devices()[0]` are interim architecture; the target
> is a per-saved-device adapter instance commissioned through the Add-device wizard.

Design document and research log for the plugin system described in
[`PROJECT-BRIEF.md`](PROJECT-BRIEF.md). Read that first for the product goal; this document
covers **how the extension system is built** and **what already exists in the world** so the
ATORCH plug does not have to be reverse engineered from scratch.

> The layer above this one — one list of the devices you own, a screen each, and wiring them
> together — is designed in [`DEVICES-AND-AUTOMATION.md`](DEVICES-AND-AUTOMATION.md). The
> distinction that matters: a plugin is a **driver**; the things it provides are **devices**.

Status: **stages 1–3 built** (SDK, host, action gateway, Tuya plugin, fake plugin). Awaiting a
local key to complete the hardware bring-up. Stages 4–8 — history, Extensions UI, controller,
arming gate, Home Assistant plugin — are still design only.

### What exists today

| Piece | Where | State |
| --- | --- | --- |
| Contract | `packages/plugin-sdk` | manifest, capabilities, scoped context, config schema + validation |
| Host | `server/src/plugins/host.ts` | discovery, lifecycle, config, secrets, grants, capability registry |
| Action gateway | `server/src/actions/gateway.ts` | grant → policy → freshness → one command → two-stage verification → audit |
| Storage | `server/src/history/db.ts` | `bun:sqlite`; config, secrets, grants, audit timeline |
| Tuya plugin | `packages/plugins/tuya-local-grid-relay` | 3.3 / 3.4 / 3.5 framing, session handshake, discovery, ATORCH profile |
| Fake plugin | `packages/plugins/fake-grid-relay` | in-memory relay with injectable faults |
| API | `server/src/index.ts` | `/api/plugins`, `/api/grid`, `/api/audit` |

Verified end to end against the simulator: grant refusal, confirmation requirement, dwell, stale
telemetry refusal, `verified`, and `unverified` when the plug reports success but the station's AC
input does not agree. 177 tests pass.

---

## 1. Why this exists

The brief describes an open-source **core + extensions** product: the station application is
useful with zero extensions, while weather, smart plugs, prices and home automation are optional
integrations. None of that exists yet — the repository today is station-only.

The first extension is the one the whole backup-reserve feature depends on: an ATORCH S1W smart
socket upstream of the P280's AC input, switched **off** so the station runs the household from
battery and solar, and switched back **on** at a reserve state of charge.

That framing matters more than it sounds. This is not a plugin that fetches a forecast. It is a
plugin that **cuts mains power to a battery system**, where being wrong means either a flat pack
that cannot restore its own charging input, or an unnecessary outage. So the architecture is
organised around one question — *who is allowed to actuate, under what checks, and what counts as
proof it worked* — rather than around module loading.

The chain the brief specifies, which this design implements literally:

```
plugin signal          relay state, W/V/A/kWh, availability, freshness
plugin recommendation  "solar likely low tomorrow"            — no authority
core policy decision   reserve, hard floor, dwell, freshness, mode
core command intent    "restore grid AC", with reason and confirmation
approved plugin action one typed relay command, and verified evidence it happened
```

### Decisions taken

| Question | Decision |
| --- | --- |
| How to reach the S1W | **Direct Tuya LAN first**, Home Assistant second against the identical contract |
| Scope of the first slice | Observe **and** manual switching **and** the automation controller |
| Where plugins live | **In-repo workspace packages** only; external npm discovery deferred |

---

## 2. Shape

```
packages/
  protocol/                     station protocol (exists, unchanged)
  plugin-sdk/                   NEW  contracts only, zero deps, shared by host and plugins
  plugins/
    tuya-local-grid-relay/      NEW  com.tuya-local.grid-relay
      src/profiles/             NEW  per-model datapoint maps as DATA — a new plug lands here
    fake-grid-relay/            NEW  in-memory relay: tests, and the simulator story
server/src/
  plugins/                      NEW  host: discovery, lifecycle, config, secrets, capabilities
  actions/                      NEW  the gateway: policy, execution, verification, audit
  automation/                   NEW  the reserve controller state machine
  history/                      NEW  bun:sqlite store + migrations
client/
  app/(tabs)/extensions.tsx     NEW  catalog, schema-driven setup, grants, health
  app/(tabs)/energy.tsx         NEW  reserve, relay, automation state and reasons
```

`packages/plugin-sdk` mirrors `packages/protocol`: TypeScript source, no build step, no runtime
dependencies, consumed by Bun and by Metro.

> **Build note:** the root `package.json` workspaces list uses `packages/*`, which does not reach
> `packages/plugins/*`. That glob must be added, or nothing under it links.

Two rules make the modularity real rather than decorative:

1. **A plugin imports only `@kraftverk/plugin-sdk`.** No station driver, no database handle, no
   `fetch`, no core configuration. Everything arrives through its `PluginContext`.
2. **A plugin can never actuate directly.** It *registers* a capability; only the core's action
   gateway invokes it.

---

## 3. The contract — `packages/plugin-sdk`

```ts
export type PluginManifest = {
  id: string;                       // reverse-DNS, e.g. "com.tuya-local.grid-relay"
  name: string;
  version: string;                  // semver of the plugin
  apiVersion: '1';                  // SDK contract it was built against
  kind: 'grid-relay' | 'weather' | 'pv-forecast' | 'price' | 'home-automation';
  // Named for the role, not the hardware. Read and switch are separate grants,
  // so a metering-only plug can never be asked to actuate — see §10.1.
  capabilities: CapabilityName[];   // e.g. ['powerMeter.read', 'gridRelay.read', 'gridRelay.switch']
  configSchema: ConfigSchema;       // rendered generically by the app; no values, no secrets
  ui: { icon: string; setupHelp?: string; customPanel?: boolean };
};

export interface KraftverkPlugin {
  readonly manifest: PluginManifest;
  validateConfig(config: unknown): ValidationResult;
  start(context: PluginContext): Promise<void>;
  stop(): Promise<void>;
  health(): PluginHealth;           // { status, detail?, lastOk?, dataAgeMs? }
}
```

### Capabilities are typed, versioned, and named per physical resource

The relay capability, the only one implemented now:

```ts
export type RelayState = {
  relayOn: boolean;
  reachable: boolean;
  watts?: number; volts?: number; amps?: number; kwh?: number;
  hz?: number; powerFactor?: number;
  updatedAt: string;                // when the device last actually answered
};

export interface GridRelayProvider {
  getState(): Promise<RelayState>;                               // signal — free to read
  setRelay(on: boolean, reason: string): Promise<CommandResult>; // gateway-only
  health(): Promise<PluginHealth>;
  /** What the relay does after a power cut. The fail-safe design depends on knowing. */
  readonly bootBehaviour: 'on' | 'off' | 'last' | 'unknown';
}
```

`weather.forecast`, `pv.forecast` and `price.forecast` are **declared as types now and left
unimplemented**, so the SMHI plugin later slots in without touching the host.

### `PluginContext` — scoped facilities only

Exactly the brief's list, and nothing else:

| Facility | Shape | Bound by |
| --- | --- | --- |
| `log` | `info` / `warn` / `error` | prefixed with the plugin id |
| `store` | `get` / `set` / `all` + `sql(migration)` | tables namespaced `p_<slug>_*`; no core tables |
| `secrets` | `get(key)` | its own secrets only, never listed back over the API |
| `schedule(everyMs, fn)` | cancelled on `stop()` | overlap-guarded, jittered |
| `http` | `fetch` wrapper | mandatory timeout, host allowlist from the manifest |
| `emit(event)` | typed plugin events | lands in the audit timeline |
| `registerCapability(name, impl)` | typed | rejected if not declared in the manifest |

### `ConfigSchema` is a deliberately small JSON-Schema subset

Fields typed `string | number | boolean | enum | secret | host`, each with title, description,
default, required and range. Bounding the subset is what lets the app render **any** plugin's
setup form from the existing `Row` / `ToggleRow` / `SegmentedControl` / `SliderRow` primitives
with no plugin-supplied code — the constraint that keeps the iOS build reviewable, as the brief
insists.

---

## 4. The host — `server/src/plugins`

| File | Job |
| --- | --- |
| `registry.ts` | discover `packages/plugins/*` via a `kraftverk` key in `package.json`, import, validate manifest, check `apiVersion` |
| `instance.ts` | one plugin's lifecycle and status machine |
| `config.ts` | non-secret config: read, validate against schema, persist, restart the plugin |
| `secrets.ts` | write-only secret store |
| `capabilities.ts` | `{pluginId, capability} → impl`, plus which provider is **active** per resource |

Status, as the brief enumerates it:
`not-installed → installed → needs-configuration → starting → healthy | degraded | failed | disabled`

Isolation rules, all testable:

- Every plugin call is wrapped in a timeout and try/catch. **A plugin cannot take the station link
  down** — a failure marks the plugin `failed` and the core keeps serving telemetry.
- An incompatible `apiVersion` disables the plugin with a readable reason; it does not fail boot.
- `health()` is polled on a schedule and carries `dataAgeMs`. **Stale never renders green** — the
  UI shows the age, and the gateway treats stale as unusable.
- Exactly **one active provider per physical resource**. Several relay plugins may be installed;
  the user picks which one owns `gridRelay`. No silent blending, no automatic failover.

### Secrets, honestly

Local keys and API tokens live in the same SQLite file under `server/data/` (already gitignored),
encrypted with AES-256-GCM when `KRAFTVERK_SECRET_KEY` is present in the environment, and stored
in the clear otherwise **with a warning surfaced in `/api/plugins` and on the Extensions screen**.
Storing an encryption key next to the data it encrypts would be theatre; this design says which of
the two you are getting. Secret fields are never returned by the API — the UI shows `set` /
`not set` — and configuration export omits them entirely.

---

## 5. The action gateway — `server/src/actions`

The heart of the design. Nothing outside this module may call `setRelay`.

```ts
execute(intent: {
  resource: 'gridRelay';
  desired: boolean;
  reason: string;                 // human sentence; ends up in the timeline
  actor: 'user' | 'controller';
  confirmation?: string;          // required for first actuation, and for any user-initiated OFF
})
```

Steps, in order, each one auditable:

1. **Resolve** the active provider; refuse if none, or if the plugin is not `healthy`.
2. **Grant check** — the capability must be granted and not revoked.
3. **Policy check, re-evaluated at execution time, not at configuration time**: read-only mode,
   manual override, cooldown and dwell, and — once the controller exists — reserve and hard-floor
   rules.
4. **Freshness check** — station telemetry *and* relay state must both be fresh, or the intent is
   refused. Acting on stale data is exactly how a controller cuts mains at the wrong moment.
5. **Audit the intent** before touching anything.
6. **Issue exactly one command.**
7. **Verify in two stages, recorded as distinct facts.** The brief is explicit that these must not
   be conflated:
   - `relay reported` — the plugin's own readback says the relay moved;
   - `station agrees` — P280 AC input presence moves in the expected direction within a timeout,
     read from telemetry the core already holds.
8. **Audit the outcome**: `verified | unverified | failed`, carrying both pieces of evidence.
9. **On unverified → FAILSAFE.** Never auto-retry an unverified OFF. ON gets a bounded retry
   subject to dwell, then `GRID_UNAVAILABLE`. Never a relay cycle.

`GRID_UNAVAILABLE` — relay confirmed ON but the station still reports no AC — is a first-class
state precisely because software cannot distinguish a grid outage from a failed relay, and must
not keep switching while it wonders.

---

## 6. History and audit — `server/src/history`

`bun:sqlite` (built into Bun, no dependency) at `server/data/kraftverk.db`, migrations run
transactionally at boot:

- `sample` — one row per minute: SOC, in/out W per source, AC volts/Hz, charging state, relay
  state, relay W/V/A/kWh, automation state. Stored UTC, displayed Europe/Stockholm.
- `audit` — every intent, command, ack, readback, verification and grant change.
- `event` — plugin lifecycle and health transitions.

This is Stage 3 of the brief, and the controller cannot be honest without it: dwell timers,
projections and "why did it do that" all read from here. CSV/JSON export from the start.

---

## 7. The reserve controller — `server/src/automation`

States exactly as the brief names them: `DISABLED`, `OBSERVE`, `BATTERY_FIRST`, `GRID_SUPPORT`,
`FORECAST_HOLD`, `MANUAL_AC_ON`, `FAILSAFE`, `GRID_UNAVAILABLE`. `FORECAST_HOLD` is enumerated but
unreachable until a weather plugin exists.

Configuration is validated as a **relationship**, and rejected otherwise:

```
P280 discharge floor  <  hardFloorSOC  <  reserveSOC  <  batteryStartSOC
P280 AC charge limit  ≥  gridRechargeTargetSOC
```

Defaults: hard floor 15 %, reserve 30 %, battery-first at 40 %, 20 W sustained for 60 s, at least
5 SOC points of hysteresis, at least 10 minutes between relay changes.

A tick every 10 s reads fresh telemetry, fresh relay state and dwell timers, then proposes at most
one transition through the gateway. On process start it takes **no** relay action until both relay
state and station telemetry are known — and if AC was last left off while the relay is
unreachable, it raises a prominent alert, because software cannot promise to restore mains it
cannot reach.

**How it ships.** The controller is built whole and runs in `OBSERVE`: it computes and logs every
decision it *would* take, with reasons, so the brief's 7–14 days of evidence accumulate. Manual
switching is live from day one through the same gateway, so the S1W acceptance drill is performed
through the app with an audit trail instead of by hand. **Arming** it is a separate, explicit act
gated on a checklist: relay plugin healthy, boot behaviour recorded, acceptance drill logged,
independent-power question answered, and **API authentication enabled** — the brief is right that
an unauthenticated LAN endpoint must not be permitted to cut mains, and today's API has none.

---

## 8. API

```
GET    /api/plugins                       manifests, status, health, data age, grants
GET    /api/plugins/:id/config            schema + non-secret values + which secrets are set
PATCH  /api/plugins/:id/config            validate → persist → restart that plugin only
POST   /api/plugins/:id/enable | disable
POST   /api/plugins/:id/test              side-effect-free probe (Tuya: dump datapoints)
POST   /api/plugins/:id/grants            grant/revoke; actuators need two-step confirmation
GET    /api/grid                          relay state + freshness + active provider
POST   /api/grid/relay                    manual intent → gateway (confirmation required)
GET    /api/automation                    mode, state, reason, next decision, requirements
PATCH  /api/automation                    thresholds; mode changes; arm/disarm
GET    /api/audit?since=                  the timeline
GET    /api/history?from=&to=&fields=     samples, CSV or JSON
```

> `POST /api/grid` **already exists** as a simulator-only affordance in `server/src/index.ts` and
> must be renamed (`/api/simulator/grid`) to free that path.

---

## 9. App

### How one screen serves every plugin

Built and working — but **the Extensions tab leaves the primary navigation**. It
was the right screen for "manage installed drivers" and the wrong destination for
"add a plug": people think in devices. What follows describes the rendering
machinery, which survives intact inside the device canvas, the add-device wizard
and device-scoped settings. See
[`DEVICE-FIRST-REFACTOR.md`](DEVICE-FIRST-REFACTOR.md).

The generic renderer works from what an adapter declares:

- **Cards** group by kind and show status, freshness and `health.facts` — label/value pairs the
  plugin formats itself, so the same row reads "Relay: on · 240 W" for a plug and "Now: 4 °C ·
  Tomorrow: 1.9 kWh" for a weather source with no client change.
- **A setup wizard that derives its own steps** from declarations and state: *find it, settings,
  turn it on, check it works, permission to switch mains, use it as the grid relay.* A weather
  plugin declares no actuator capability and owns no resource, so it simply gets the first four.
- **`SchemaForm`** renders any plugin's settings from its `ConfigSchema`. Six field types, all
  mapping to controls the app already had; secrets are write-only and show as *stored*.
- **Setup actions** render as a button plus a generated form, and their `choices` as a pick-list
  whose selection writes the plugin's supplied values straight into the settings form.
- **Consent** is two-step and appears only for capabilities `isActuator()` says are physical.

### Plugin-supplied panels

A plugin package may ship its own screen at `ui/panel.tsx`, bound at compile time through
`client/src/plugins/panels.ts` — the single point of coupling between the app and any specific
plugin. Three rules keep it from becoming a hole:

1. **A missing panel is invisible.** The generic screen is always sufficient.
2. **Panels are compile-time contributions, never downloaded** — an iOS build must not fetch and
   execute UI code.
3. **A panel gets data and callbacks, not privileges.** `switchRelay` goes through the action
   gateway exactly as the generic control does.

Verified in a real web bundle: the Tuya panel ships, while its server code — the LAN session, the
cloud client, `node:net` — does not.

- **Advanced app settings, not a tab** — catalog by category; per-adapter card with icon, status, data age and last
  error; setup form generated from `configSchema`; secrets masked and write-only; Test button;
  capability consent screen with the actuator warning and two-step confirmation; activity log;
  configuration export.
- **Energy tab** — SOC against reserve and hard-floor markers; live load, solar, grid and relay
  state; automation state in plain language with the reason for the last decision and the next
  planned one; Restore AC now; Dry run / Observe / Armed; event timeline; CSV export.
- **Dashboard** stays station-first: at most a small "Grid relay: Tuya Local · 12 s ago" badge,
  plus the third grid-path visual state the brief calls for — *connected*, *disconnected by
  automation*, *unavailable* — because rendering an automation-driven disconnect identically to a
  power cut is exactly the confusion to avoid.

---

## 10. The grid relay: one contract, many plugs

This is where the modularity has to earn its keep. The ATORCH S1W is the first plug, not the only
one anybody will ever own, so "support a new plug" must not mean "touch the automation".

### 10.1 Four layers, each replaceable without the others

```
automation + action gateway     knows only GridRelayProvider — never a vendor, never a datapoint
        ↑
capability contract             packages/plugin-sdk        stable, versioned
        ↑
plugin  = one per protocol      tuya-local | openbeken-mqtt | homeassistant | shelly | tasmota
        ↑
device profile = data           atorch-s1w, generic-tuya-plug, …        ← most new plugs stop here
```

The rule that keeps it honest: **the capability is named for the role, not the hardware.** The
core depends on `gridRelay`, "the thing that can interrupt the station's AC input", not on
"ATORCH" or "Tuya". A plug repurposed to measure some other circuit is a different capability, not
a second grid relay.

That also means the read and switch halves are **separate capabilities**:

| Capability | Grants | Typical holder |
| --- | --- | --- |
| `powerMeter.read` | V, A, W, kWh, Hz, power factor, freshness | any metering plug, including ones that never switch |
| `gridRelay.read` | relay position, reachability, boot behaviour | any switchable plug |
| `gridRelay.switch` | **actuation** — gateway-only, needs an explicit grant | the one plug wired upstream of the P280 |

A plug that only measures declares the first and can never be asked to switch anything, because
the implementation for that verb does not exist on it.

### 10.2 Device profiles are data, not code

Everything model-specific lives in a profile, not in the plugin's logic — the same structural
choice [`make-all/tuya-local`](https://github.com/make-all/tuya-local) made with its YAML device
configs, which is why that project supports hundreds of devices without hundreds of integrations.

```ts
export type TuyaDeviceProfile = {
  id: 'atorch-s1w';
  label: 'ATORCH S1W / S1WP';
  protocol: '3.3' | '3.4' | '3.5';
  /** Which datapoint actually switches the relay. Sources disagree for this model — see §11.2. */
  relay: { dp: number; kind: 'boolean' };
  metrics: {
    volts?:   { dp: number; scale: number };   // scale 2 → raw 23000 = 230.00 V
    amps?:    { dp: number; scale: number };
    watts?:   { dp: number; scale: number };
    kwh?:     { dp: number; scale: number };
    hz?:      { dp: number; scale: number };
  };
  /** Recorded from a real power-cut test, never assumed. */
  bootBehaviour: 'on' | 'off' | 'last' | 'unknown';
  quirks?: { controlCommand?: 'CONTROL' | 'CONTROL_NEW'; pollSeconds?: number };
};
```

Profiles ship with the plugin, are selectable in the setup form, and every field is overridable
per-installation — because the honest position from §11.2 is that two published sources disagree
about this very device, so the profile is a *starting point* the datapoint dump confirms or
corrects.

### 10.3 Adding another plug

| Situation | Work required |
| --- | --- |
| Another Tuya plug (Shelly-branded Tuya, generic 16 A socket…) | **A profile. No code.** Run the datapoint dump, write ~15 lines of data, add a fixture test |
| A plug on a protocol we already speak (a second OpenBeken device) | Configuration only |
| A new protocol (Shelly Gen2 RPC, Tasmota HTTP, Matter) | **One new plugin** implementing `GridRelayProvider` — typically a single file plus its manifest. Nothing in `server/src/automation` or `server/src/actions` changes |
| A plug behind Home Assistant | Already covered by `com.homeassistant.grid-relay`; entity ids are configuration |

The test that proves the abstraction is real is Stage 8: the Home Assistant plugin must drop in
with **zero** changes to the controller or the gateway. If it cannot, the contract was wrong and
gets fixed then — while there are two implementations to compare, rather than after there are ten.

### 10.4 The three providers planned

All implement the identical contract; the automation logic never learns which is in use.

| Provider | Path to the plug | Trade-off |
| --- | --- | --- |
| `com.tuya-local.grid-relay` | Direct Tuya LAN, TCP 6668 | No cloud, no extra services. Needs the device's local key, and protocol 3.4/3.5 adds a session handshake |
| `org.openbeken.grid-relay` | Vendor firmware replaced by OpenBeken; plain MQTT | Simplest and most robust once done — **and this server already runs an MQTT broker for the station**. Costs: flashing risk, warranty |
| `com.homeassistant.grid-relay` | Home Assistant REST API | Least protocol work, reuses an existing trusted setup. Costs: HA becomes a dependency in the path that restores mains |

Chosen order: **Tuya LAN first**, Home Assistant second (proving the abstraction holds).
OpenBeken is documented as the escape hatch if the LAN protocol proves painful — see §11.5.

---

## 11. Research: what already exists

The instruction was to reuse working implementations rather than reverse engineer. Here is what
the ecosystem already provides, and what it means for us.

### 11.1 The protocol is fully documented

[`jasonacox/tinytuya`](https://github.com/jasonacox/tinytuya) publishes
[`PROTOCOL.md`](https://github.com/jasonacox/tinytuya/blob/master/PROTOCOL.md), a complete
specification of the Tuya LAN protocol. Nothing here needs discovering:

| Aspect | 3.1 | 3.3 | 3.4 | 3.5 |
| --- | --- | --- | --- | --- |
| Frame prefix / suffix | `55AA` / `AA55` | `55AA` | `55AA` | `6699` / `9966` |
| Encryption | AES-ECB (control only) | AES-ECB (all) | AES-ECB + session key | AES-GCM + session key |
| Integrity | CRC32 | CRC32 | HMAC-SHA256 | GCM tag |
| Handshake | none | none | 3-way | 3-way |

- Frame layout: prefix, 32-bit sequence, 32-bit command, length, payload, integrity, suffix.
- Session negotiation (3.4/3.5): `START 0x03` client nonce → `RESP 0x04` device nonce +
  HMAC-SHA256 → `FINISH 0x05`. Session key is the XOR of both nonces, then AES (ECB for 3.4;
  GCM for 3.5, IV = first 12 bytes of the client nonce).
- Commands: status `0x0A` (`DP_QUERY`) or `0x10` (`DP_QUERY_NEW` on 3.4+), control `0x07`
  (`CONTROL`) or `0x0D` (`CONTROL_NEW` on 3.4+ and "device22" units).
- Transport: TCP **6668**; UDP broadcast discovery on 6666/6667. Persistent connections keep the
  negotiated session key.

The parallel with this project's MODBUS work is exact — and this time somebody else has already
written the specification down.

### 11.2 This exact device family is already supported elsewhere

[`make-all/tuya-local`](https://github.com/make-all/tuya-local) (Home Assistant integration) lists
**"Atorch S1BW, S1WP energy monitoring switches with display"** among its supported devices, along
with several other Atorch units (AT2PL breaker, DT20HBW DC monitor, S1TW thermostat). Its device
configuration files are the closest thing to a published datapoint map for our plug.

Datapoints gathered from its issue tracker:

| DP | Meaning | Notes |
| --- | --- | --- |
| 1 | `switch_1` — relay | boolean; **but see the warning below** |
| 9 | countdown timer | seconds, 0–360000 |
| 17 | `add_ele` — energy increment | |
| 18 | `cur_current` | scale 3 → mA |
| 19 | `cur_power` | scale 2 |
| 20 | `cur_voltage` | scale 2 |
| 101 / 102 / 103 | price / cost / added cost | |
| 104 / 105 / 106 | over-voltage / over-current / over-power protection | |
| 123 | `ele` — total energy (kWh) | |
| 131 / 132 | relay mode, warning flags | |
| 133 / 134 / 135 | frequency, power factor, CPU temperature | |

Product ids seen in the wild: **S1WP `sqrf2g1amfutn4co`**, **S1BW `pl28o0wkaopyft8u`** (the S1BW is
described as "the same as S1WP but with bluetooth").

> ⚠️ **Sources disagree about which datapoint actually switches the relay.** The Tuya product
> specification lists DP 1 as the switch, while the OpenBeken community reports that on this
> ATORCH S1 "the real relay control" is **dpId 131**, with DP 1 apparently not doing the job.
> This is precisely the "do not guess datapoints" warning in the brief, and it is why the first
> hardware step is a datapoint dump on the actual unit, recorded in the config and in the findings
> document — the same discipline that produced `P280-FINDINGS.md`.

Also relevant: [`Windear/local_tuya_3.5`](https://github.com/Windear/local_tuya_3.5), a Home
Assistant component written specifically for Atorch-branded Tuya energy meters that need protocol
**3.4/3.5** persistent connections — evidence that at least some Atorch units are on the newer
protocol, so a 3.3-only client is not safe to assume.

### 11.3 Libraries we could depend on

| Project | Language | Protocols | Assessment |
| --- | --- | --- | --- |
| [`codetheweb/tuyapi`](https://github.com/codetheweb/tuyapi) | JS | 3.1–3.3 | Mature and widely used, but the maintainer has stated they are not developing it further beyond reproducible bug fixes; 3.4 and 3.5 are open requests ([#481](https://github.com/codetheweb/tuyapi/issues/481)) |
| [`@tuyapi/driver`](https://github.com/tuyaapi/driver) | **TypeScript** | unverified | Same organisation's "next-gen" driver, committed as recently as Aug 2026, but only ~20 stars — young and unproven. **Evaluate first**: if it covers 3.4/3.5 cleanly it is the best fit for a Bun/TS server |
| [`jasonacox/tinytuya`](https://github.com/jasonacox/tinytuya) | Python | 3.1–3.5 | The reference implementation and the spec author. Not a runtime dependency for us, but the commissioning tool of choice |
| [`tuyaapi/stub`](https://github.com/tuyaapi) | JS | — | "A stub implementation of the Tuya protocol for local testing" — worth mining for our `fake-grid-relay` tests |

**Recommendation:** evaluate `@tuyapi/driver` against the real plug first. If it handles the
device's protocol version, depend on it. If not, fall back to `tuyapi` when the plug turns out to
speak 3.3, and only implement the 3.4/3.5 handshake ourselves — guided by `PROTOCOL.md`, not by
packet capture — if the device forces it. In every case the plugin boundary means this choice is
swappable without touching automation logic.

### 11.4 Commissioning: local key, discovery, datapoint dump

Reusing existing tooling rather than writing any of it:

- **Local key + device id** — `python -m tinytuya wizard` (needs a Tuya IoT developer account,
  linked to the Smart Life app by QR code), or `npm i @tuyapi/cli -g && tuya-cli wizard`. The
  device must first be activated in the Smart Life app.
- **LAN scan** — `python -m tinytuya scan` prints address, device id and **protocol version**,
  which settles the 3.3 vs 3.4/3.5 question for our unit in one command.
- **Datapoint dump** — tinytuya's `detect_available_dps()`, and afterwards our own
  `POST /api/plugins/:id/test`, which dumps every datapoint with raw value and type so the map is
  recorded in configuration rather than assumed.

### 11.5 The escape hatch: replace the firmware

The ATORCH S1-B/W/T/H is built on a **BK7231N (CB2S/C3BS) module**, which
[OpenBeken](https://github.com/openshwprojects/OpenBK7231T_App) supports — a Tasmota/ESPHome-style
open firmware — and
[tuya-cloudcutter](https://www.elektroda.com/rtvforum/topic3979215.html) can flash it **over
Wi-Fi, without opening the case or soldering**. Community reports say that from OpenBeken 1.17.406
this ATORCH S1 works with nine mapped channels and relay control on dpId 131.

Why this is worth taking seriously for *this* project specifically: an OpenBeken plug speaks plain
MQTT, and **this server already embeds an MQTT broker** (`server/src/mqtt/broker.ts`, aedes) for
the station. The relay plugin would then be a few topic subscriptions with no local key, no cloud
account, no protocol-version negotiation and no session handshake — dramatically less surface than
the Tuya LAN path, and philosophically identical to what the project already did to the P280 by
redirecting `mqtt.sydpower.com`.

Costs are real: flashing can brick the plug, it voids any warranty, and it is a one-way door in
practice. Recorded here as a deliberate option, not a recommendation.

### 11.6 What the network already told us

Run on this LAN with `npm run scan:tuya` — no credentials, no cloud account:

| Device | Address | Protocol | Product key |
| --- | --- | --- | --- |
| `bf8dc9…96h6ff` | 192.168.50.74 | **3.4** | `keym557nqw3p8p7m` |
| `505660…f4d5` | 192.168.50.17 | **3.3** | `toidnjcqfwlzqnlp` |

Two Tuya devices, on two different protocol versions — which is why the plugin implements both
and defaults to **Detect**, trying 3.4 → 3.3 → 3.5 and reporting which one answered. The second
device's id embeds its MAC (`bcddc23af4d5`, an Espressif OUI); the ATORCH S1 uses a Beken
BK7231N, so the 3.4 device is the more likely plug — but neither is confirmed until a local key
allows a datapoint dump.

Connecting with a deliberately wrong key produced the diagnostic this design wants:

```
3.4: Connection closed | 3.3: connected, but no datapoints could be decoded —
usually a wrong local key | 3.5: The device did not answer command 0x3 in 5000ms
```

### 11.7 Still to be established on the actual unit

Nothing above substitutes for these, and each is a first-slice task:

1. Exact model and product id (the brief's listing points at S1W; the published configs are for
   S1BW/S1WP).
2. Protocol version — from `tinytuya scan`.
3. **Which datapoint really switches the relay** — DP 1 or DP 131.
4. Scaling of voltage, current, power and energy datapoints, confirmed against the plug's own LCD.
5. **Power-on relay behaviour** — on, off, or last state. The fail-safe design depends on this and
   it must be tested with a real power cut, not assumed.
6. Sustained current and plug temperature during a full P280 AC charge. Marketing says 16 A, but a
   reseller specification for the S1W gives the **internal relay as 10 A / 2650 W at 265 V**; the
   P280's 1800 W input is ≈7.8 A at 230 V, inside that figure but not by a wide margin.

---

## 12. Order of work

| # | Stage | Done when |
| --- | --- | --- |
| 1 | SDK contracts + host + `fake-grid-relay` | fake relay loads, configures, reports health; unit tests green |
| 2 | Action gateway + audit + `/api/grid` | grant, dwell, freshness and verification enforced against the fake, including unverified-OFF-no-retry |
| 3 | Tuya Local plugin | datapoint dump from the real S1W; state reads; manual switching verified end to end |
| 4 | History store | one-minute samples for station and relay; CSV export |
| 5 | Extensions UI | S1W configurable and grantable from the app |
| 6 | Controller in OBSERVE + Energy UI | decisions logged with reasons; nothing switches |
| 7 | Arming gate | checklist enforced; API authentication added; only then may the controller actuate |
| 8 | Home Assistant relay plugin | same contract, second implementation — proof the abstraction holds |

---

## 13. Verification

- **Unit** (`packages/plugin-sdk`, `packages/plugins/*`): manifest and configuration validation,
  capability registration refused when undeclared, Tuya frame encode/decode against captured
  bytes — the approach `packages/protocol/src/modbus.test.ts` already uses for MODBUS.
- **Gateway** (against `fake-grid-relay`): refuses without a grant; refuses on stale telemetry;
  refuses inside dwell; marks `unverified` when the relay reports success but the station does not
  agree; never retries an unverified OFF; bounded ON retry then `GRID_UNAVAILABLE`; no cycling.
- **Controller**: threshold and hysteresis boundaries, intermittent load, stale telemetry, relay
  unavailable mid-transition, server restart with the plug off, manual override, DST transition.
- **On hardware, in order**: `tinytuya scan` → datapoint dump → 20 manual toggles with no critical
  load, all logged → power-cut test to establish boot behaviour → relay OFF with a small load,
  confirming the P280's AC input disappears in **both** station telemetry and the S1W meter →
  transfer test → a full charge cycle watching current and plug temperature.
- **End to end without hardware**: `npm run dev` (station simulator) plus `fake-grid-relay` gives a
  complete, clickable reserve story for development and CI.

---

## 14. Out of scope here

Weather and PV forecasting (`se.smhi.weather`, PVGIS, Forecast.Solar), price plugins,
`FORECAST_HOLD`, external npm plugin discovery, and any unattended automation before the arming
checklist passes.

---

## Sources

- [tinytuya](https://github.com/jasonacox/tinytuya) and its
  [PROTOCOL.md](https://github.com/jasonacox/tinytuya/blob/master/PROTOCOL.md) — Tuya LAN protocol
  specification, wizard, scan, datapoint detection
- [make-all/tuya-local](https://github.com/make-all/tuya-local) —
  [DEVICES.md](https://github.com/make-all/tuya-local/blob/main/DEVICES.md) lists Atorch S1BW/S1WP;
  [issue #3253](https://github.com/make-all/tuya-local/issues/3253) (S1BW datapoints, product id)
  and [issue #1103](https://github.com/make-all/tuya-local/issues/1103) (S1WP datapoint dump)
- [Windear/local_tuya_3.5](https://github.com/Windear/local_tuya_3.5) — Atorch energy meters on
  protocol 3.4/3.5
- [codetheweb/tuyapi](https://github.com/codetheweb/tuyapi) and
  [issue #481](https://github.com/codetheweb/tuyapi/issues/481) — Node client, 3.4 support request
- [@tuyapi/driver](https://github.com/tuyaapi/driver) — TypeScript next-generation driver
- [OpenBK7231T_App / OpenBeken](https://github.com/openshwprojects/OpenBK7231T_App) and the
  [ATORCH S1 teardown thread](https://www.elektroda.com/rtvforum/topic4003739.html) — BK7231N
  module, relay on dpId 131, MQTT firmware replacement
- [tuya-cloudcutter device list](https://www.elektroda.com/rtvforum/topic3979215.html) — over-the-air
  flashing without soldering
- [Tuya Local and Protocol 3.5 support](https://limbenjamin.com/articles/tuya-local-and-protocol-35-support.html)
