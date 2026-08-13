# Device-first refactor: authoritative target architecture

## Decision

This document supersedes earlier UI sequencing in `DEVICES-AND-AUTOMATION.md`,
`PLUGIN-ARCHITECTURE.md`, `PROJECT-BRIEF.md`, and `HANDOFF.md` where they conflict.
The application is a **device catalog first**, not a station dashboard with extra
features bolted on.

For package, protocol, server and API-client boundaries, also read
[`MODULAR-CODE-ARCHITECTURE.md`](MODULAR-CODE-ARCHITECTURE.md).

On a new installation the root screen is an empty, calm **Your devices** canvas:

```text
Your devices

  You have not added anything yet.
  Add your first device to monitor it, configure it, and later connect it to automations.

  [ + Add a device ]
```

No device is silently adopted because it happened to be visible on a transport.
Discovery proves a candidate is reachable; only the user completing the wizard
creates a persistent device. A device remains listed after it goes offline. This
is the core product model:

```text
installed adapter/plugin  → knows a protocol or service
discovered candidate      → temporary result during setup
saved device              → a named thing the user owns; stored in SQLite
connection                → the selected, configured way the core reaches that device
automation                → a separate configuration that assigns saved devices to roles
```

The first supported saved devices are:

1. An AFERIY P280 power station.
2. A smart plug/relay, initially ATORCH S1W through a compatible adapter.

Weather, price, Home Assistant, and similar integrations remain optional plugins;
they are not devices the owner has to add to the primary device canvas unless a
future product choice deliberately exposes them as services.

---

## UX and information architecture

### 1. Root: Your devices

This is the app's initial route and its default home after setup. It contains only:

- device cards grouped by user-facing category, with online/stale/offline state;
- a visible `Add device` card/button;
- a quiet `Automations` entry only after at least two compatible devices exist;
- a secondary `App settings` entry for advanced infrastructure tasks.

Do not show global Dashboard, global Settings, Protocol, Extensions, or a global
Station Link tab. Those labels imply one privileged device and expose implementation
details before the user has added anything.

### 2. Add-device wizard

Adding must be one continuous, resumable wizard. It is driven by adapter-provided
metadata and a core-owned state machine; it must not tell the user to configure an
extension on another screen and come back later.

Required stages:

1. **Choose category** — Power station, Smart plug/relay; later categories can be
   supplied by installed adapters. Show unavailable choices only when there is an
   actionable installation requirement.
2. **Choose model/adapter** — P280 and its verified/untested compatible models;
   ATORCH or another relay adapter. Clearly mark whether a model/profile is verified.
3. **Choose connection owner and transport** — server Wi-Fi/MQTT, server BLE,
   client BLE, or another adapter-supported connection. Explain the consequences:
   server-owned connections persist, support history and automations; a client-owned
   direct connection is only useful while the app/device/browser can maintain it.
4. **Discover** — scan/browse candidates using only the selected connection method.
   Display identity, model/name, address/MAC/RSSI where safe, and confidence. It is
   not a device card and does not enter the database.
5. **Connect and verify** — establish the link and run model-specific read-only
   checks. For a P280: validate readable telemetry/holding registers and model
   compatibility. For a relay: read state/metering and run a side-effect-free test.
   A physical switching test is separate, optional, and requires confirmation.
6. **Name and review** — user assigns the friendly name; show model, selected
   transport, connection owner, identity/fingerprint, known limitations and what is
   stored. The final button is `Add device`.
7. **Persist and enter device** — atomically save the device plus connection profile;
   only after this redirect to its Dashboard.

The wizard saves a draft in the local app state only. A cancelled/failed draft must
not create a device. It may be resumed after an app refresh, but incomplete drafts
must be explicitly discardable and must never be mistaken for working devices.

### 3. Device detail

Clicking a saved device opens a device-scoped shell with exactly two primary tabs:

```text
[ Dashboard ]  [ Settings ]
```

- **Dashboard**: live measurements, health/freshness, controls allowed for that
  device, history, and P280's power-flow visualization. A plug gets relay/meter
  information; a P280 gets battery/input/output information.
- **Settings**: user name, device-owned settings, connection details, reconnect/test,
  and Forget device. Rename changes only the catalog label. Forget requires a clear
  warning about history and automations that will be removed/disabled.

Protocol/register diagnostics are advanced device-scoped tools, accessed from the
P280 Settings screen under `Advanced`, never a global tab. Plugin setup details are
similarly device-scoped after initial commissioning. Keep an app-level Developer/
Extensions page only for installation, diagnostics, and maintainers—not normal setup.

### 4. Automations are separate

Once the battery and plug are saved, `Automations` may offer a recipe such as
**Backup reserve**. It selects *saved devices* for typed roles:

```text
Station      [ P280 living room        ▾ ]
Grid relay   [ Utility-room smart plug ▾ ]
Reserve      [ 30 % ]
```

Creating a plug must not implicitly enable an automation. Automations own their
configuration, audit state, lifecycle and references. A device can show a read-only
“Used by” list. Remove either referenced device only after disabling/deleting the
automation transactionally or after an explicit destructive confirmation.

---

## Critical gaps in the current refactor

The current work has valuable foundations, but it is not yet device-first.

| Current implementation | Why it conflicts with the target | Required correction |
| --- | --- | --- |
| `DeviceRegistry.adoptStation()` inserts a station at server start | A blank install is impossible; discovery becomes ownership | Remove automatic adoption. Offer migration/import only for legacy `binding.json` users, behind an explicit one-time banner. |
| Global `StationProvider` and global Dashboard/Settings/Protocol tabs | The station is still the app, while other devices are secondary | Make the catalog provider root-level. Move station state behind `useDeviceConnection(deviceId)` / device routes. |
| `add-device.tsx` adds the record before connection is configured | The user can create a permanently grey plug; setup lives elsewhere | Drive discovery, connection, verification, naming, then one atomic create call. |
| `link.tsx`, `client/src/link/*` represent a global station link | A link is a property of a saved P280 connection, not the whole application | Move shared BLE transport primitives into a transport package; put device-specific commissioning in the P280 adapter. |
| Server has one global `driver`, `transport`, and binding | A second P280 or per-device connection cannot be represented honestly | Introduce a `ConnectionManager` keyed by saved device id. Do not advertise multi-station until it exists. |
| `PluginHost` config is one config per plugin ID, while `DeviceRegistry` uses `plugin.devices()[0]` | One plugin cannot provide multiple independently configured plug records; saved device config is ignored by the live driver | Replace singleton-plugin device access with adapter instances keyed by saved device id. |
| `/api/device-types` maps every grid-relay plugin to a generic `smart-plug` | It does not describe connection choices, discovery, verification or model/profile support | Replace with adapter catalog + wizard-step contract. |
| Device detail has generic Overview/Controls/History/Readings/Settings/Manage sections | Good generic fallback, but does not meet “Dashboard + Settings only” navigation or model-specific rich dashboard | Retain generic components inside device Dashboard/Settings panels; let model packages provide registered panels. |
| Existing global Extensions screen is part of normal tab bar | Users think in devices, not installed driver packages | Remove it from primary navigation; link to advanced app settings only. |

### A bug/semantic issue to resolve now

`DeviceDescriptor.id` is documented as the adapter/vendor identity, while
`DeviceView.id` is overwritten with the core catalog ID. The registry then calls
`readDevice(descriptor.id)` but records/history use catalog IDs. This is workable only
for the current one-device plugin and will break as soon as one adapter discovers more
than one device. Use distinct, named identifiers:

```ts
type SavedDeviceId = string;       // core UUID; primary key and routing/history key
type CandidateId = string;         // temporary commissioning identity
type ProviderDeviceId = string;    // adapter/vendor identity, scoped to adapter instance
```

Never overload `id` in a public DTO. Return `id` for `SavedDeviceId` and explicit
`providerDeviceId` where needed.

---

## Target domain and interface contracts

### Persisted data

Replace the loose `device.config` as the main connection model with explicit,
versioned records. JSON still has a place for adapter-specific non-secret config,
but the core must be able to reason about connection and lifecycle without parsing
vendor-specific fields.

```ts
type SavedDevice = {
  id: SavedDeviceId;
  kind: DeviceKind;
  adapterId: string;                 // e.g. core.aferiy-p280 / com.tuya.local-relay
  modelId: string | null;
  name: string;
  providerDeviceId: string | null;   // MAC/device ID after commissioning
  connectionId: string;
  configVersion: number;
  adapterConfig: Record<string, unknown>; // no secrets
  addedAt: string;
  updatedAt: string;
};

type DeviceConnection = {
  id: string;
  owner: 'server' | 'client';
  transport: 'mqtt' | 'ble' | 'tuya-lan' | 'home-assistant' | 'simulator';
  status: 'unconfigured' | 'connecting' | 'connected' | 'offline' | 'error';
  fingerprint: Record<string, string>;  // MAC, advertised ID, host; avoid secret data
  config: Record<string, unknown>;      // no secrets; connection-specific
  lastConnectedAt: string | null;
  lastError: string | null;
};
```

Store secrets in the existing encrypted secret store scoped to `SavedDeviceId`, not
just plugin ID. An adapter installed once may serve ten relays with ten local keys.

Use SQLite foreign keys and a deletion transaction. Preserve device history by default
on removal only if the user explicitly selects “remove from canvas, keep history”; the
default first-version behaviour may delete both, but the UI and API must be honest and
automations must be handled first.

### Adapter contract

Rename the runtime concept from generic “plugin” to **device adapter** where it
discovers/connects hardware. Plugins may still provide services such as SMHI weather,
but a device adapter must implement this lifecycle:

```ts
interface DeviceAdapter {
  manifest: DeviceAdapterManifest;

  connectionOptions(): ConnectionOption[];
  createCommissioner(optionId: string): DeviceCommissioner;
  open(saved: SavedDevice, connection: DeviceConnection): Promise<DeviceSession>;
}

interface DeviceCommissioner {
  discover(input: unknown, signal: AbortSignal): AsyncIterable<DeviceCandidate>;
  verify(candidate: DeviceCandidate, input: unknown): Promise<VerificationResult>;
  createDraft(candidate: DeviceCandidate, input: unknown): CommissioningDraft;
}

interface DeviceSession extends DeviceProvider {
  readonly savedDeviceId: SavedDeviceId;
  health(): DeviceHealth;
  close(): Promise<void>;
}
```

`DeviceCandidate` contains a temporary ID, model/profile, display name, discovery
metadata, supported connection options and confidence. `VerificationResult` contains
read-only evidence and explicit warnings. It must not silently change physical state.

The core owns: persistence, naming, permissions, safety gateway, audit log, session
lifecycle, history, route IDs, and automation composition. An adapter owns: protocol,
discovery, transport-specific configuration, candidate verification, model-specific
measurements/controls/settings, and optional device Dashboard/Settings panels.

### Connection ownership

The owner requested server or client choice. Support it truthfully:

- **Server-owned**: required for persistence, background sampling, automations,
  history and reliable recovery. This is the recommended/default path.
- **Client-owned BLE**: a direct, foreground session from the app/browser. It may be
  used to commission, inspect, or manually control a P280, but it cannot power a
  server automation or provide continuous history while the app is closed. It is
  saved only as a reconnect preference/fingerprint, not misrepresented as a durable
  always-on device connection.

For the first device-first milestone, fully implement server-owned P280 MQTT/BLE and
server-owned relay adapters. Keep client BLE as a clearly labelled manual/diagnostic
commissioning route until a durable reconnect design exists. Do not create a fake
database device that the server cannot actually operate.

---

## Package boundaries and cleanup

The intended package layout is sensible, but its boundary needs finishing.

```text
packages/
  domain/ or plugin-sdk/            shared device, adapter, commissioning, automation contracts
  protocol/                         Sydpower frame/register codec only; no UI and no server state
  transports/ (new)                reusable BLE/MQTT transport primitives, server/client variants
  devices/aferiy-p280/
    src/                            descriptor, settings mapping, server adapter, commissioning rules
    ui/                             optional device-scoped Dashboard/Settings/Advanced panels
  plugins/tuya-local-grid-relay/
    src/                            adapter, Tuya discovery/session/profile code
    ui/                             optional plug dashboard/settings panel
  ui/                               generic cards, schema form, charts, wizard primitives
  api-client/                       server DTOs and calls only; no model-specific dependencies
client/
  app/                              routing shell only
  src/features/devices/             catalog, wizard and device shell state
  src/features/automations/         recipe list/editor state
  src/features/app-settings/        advanced host/plugin management
server/
  src/catalog/                      persistence and catalog lifecycle
  src/connections/                  ConnectionManager and session lifecycle
  src/adapters/                     adapter discovery/registry
  src/automation/                   recipes and safety policy
  src/actions/                      single physical-action gateway
```

`src` versus `ui` in `packages/devices/aferiy-p280` is not inherently wrong:
`src` is runtime/domain code that can run under Bun without React; `ui` is React/Tamagui
code that must only be bundled into the client. The problem is not the folders—it is
that the client does not yet use the device package panels and the server still holds
P280-specific global state. Keep the separation, document it, and enforce imports:

- server must never import `ui/`;
- protocol/domain packages must not import React, Expo, Tamagui or server modules;
- client should import a device panel only through a static registry, never download
  arbitrary JavaScript at runtime;
- `client/src/link` becomes `packages/transports` only after ownership is separated;
  do not move files merely to make the tree prettier.

---

## Ordered implementation plan

### Milestone A — Make the blank canvas real

1. Remove `adoptStation()` from normal startup and preserve existing `binding.json`
   only through an explicit migration/import action.
2. Change root navigation to `Your devices`; remove global station Dashboard, Settings,
   Protocol and Extensions from the primary tab bar.
3. Keep `/devices` as the API listing saved records, but return `SavedDeviceView` with
   connection health and explicit IDs.
4. Add a migration for `updated_at`, `connection`, scoped secrets and automation
   references. Write migration/CRUD tests.
5. Make deleting a device reject or explicitly cascade when it has automation references.

Acceptance: an empty database renders no station, a refresh remains empty, and a
legacy user can intentionally import—not auto-adopt—their prior station.

### Milestone B — Commission one P280 correctly

1. Implement `core.aferiy-p280` adapter and server `ConnectionManager` for one
   server-owned station session.
2. Replace the global Link page with P280 wizard steps: choose MQTT/BLE, discover,
   bind, read-only verify, name/review, atomically save.
3. On completing the wizard, create the device and connection rows, open its session,
   and route to `/device/:id/dashboard`.
4. Move P280 Dashboard, Settings and Advanced Protocol under that route. The P280
   device package provides the custom panels; generic UI supplies chrome and fallback.
5. Ensure restart reconnects only saved server-owned devices.

Acceptance: add, refresh/restart, rename, offline display, reconnect, and forget all
work for a P280 without a global station link or global station tabs.

### Milestone C — Commission one smart plug correctly

1. Convert Tuya Local from one plugin-wide configuration to a per-saved-device adapter
   instance. Move local keys/secrets to device scope.
2. Implement its wizard: select server LAN route, discover, select candidate, obtain
   or enter key through explicit setup action, read-only verify relay/metering, name,
   persist.
3. Render plug Dashboard and Settings under `/device/:id`; prove no P280-specific
   assumptions are needed.
4. Add a fake adapter/session for deterministic API and wizard tests.

Acceptance: a P280 and plug appear as two independent records after restart, either can
be offline without disappearing, and the saved plug record maps to the exact relay it
controls.

### Milestone D — Automations after devices

1. Create an automation/recipe schema with device-role foreign keys.
2. Add a Reserve recipe in `Observe` mode only; roles are selected from saved compatible
   devices, not a hard-coded active relay.
3. Add `Used by` and safe removal behaviour.
4. Only then layer on arming, safety acceptance, action gateway, SMHI, forecast and
   price plugins described in the project brief.

Do not begin weather/solar prediction or autonomous relay switching while Milestones A–C
are incomplete; otherwise the refactor will embed new global assumptions before the
device model is stable.

---

## Documentation corrections required

The documentation currently has stale status claims. For example,
`DEVICES-AND-AUTOMATION.md` says the app grid/detail screens are “next”, while they
now exist in partial form; `PLUGIN-ARCHITECTURE.md` says stages are design-only while
the host/UI/API are partly implemented. Do not rewrite history into “complete.”

From this change onward:

1. This file is the authoritative device-first architecture and implementation order.
2. `README.md` must link to it as the current refactor guide.
3. `DEVICES-AND-AUTOMATION.md` remains useful background but begins with a prominent
   pointer to this document and must not claim a fresh install shows a station.
4. `PLUGIN-ARCHITECTURE.md` must describe plugins as adapters/services and state that
   per-device adapter instances and the commissioning wizard are pending.
5. `HANDOFF.md` must list Milestone A as active and the exact known limitations above.
6. Documentation should use `P280` for the currently verified hardware model and
   a user-editable friendly name in UI examples. Do not call the model “F3” unless a
   specific F3 model has been independently identified.

## Definition of done for this refactor

The device-first refactor is done only when a new user can:

1. Open a truly empty `Your devices` screen.
2. Add a P280 through discovery, verification, naming and one atomic save.
3. Refresh/restart and find the same P280 with its settings/history/connection state.
4. Add a smart plug through the same shaped wizard without configuring a hidden global
   plugin first.
5. Open each saved device and see only its Dashboard and Settings as primary navigation.
6. Rename/remove either device safely and see dependent automations handled honestly.
7. Create a separate, initially observe-only Reserve automation that selects those
   saved devices by typed role.

Only after these behaviours are real should the project proceed to autonomous relay
control, SMHI forecasting, or a general rule builder.
