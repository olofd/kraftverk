# kraftverk

> **Architecture:** everything you add is a device, and each kind of device is a
> package of its own, reached through the connection methods it declares. The
> model, the words for it and the plan are in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), the data model in
> [`docs/DATA-MODEL.md`](docs/DATA-MODEL.md), and
> [`docs/HANDOFF.md`](docs/HANDOFF.md) is where things actually stand today.
> This README describes the code as it is now.

Local control for **Sydpower-stack portable power stations** — monitor and
control them from iOS and the browser, over Wi‑Fi or Bluetooth, **without the
vendor cloud**.

Developed and verified against an **AFERIY P280**.

<p align="center">
  <img src="docs/screenshots/dashboard.png" alt="Dashboard showing a live energy-flow diagram" width="380">
</p>

> **Unofficial.** Not affiliated with, endorsed by, or supported by AFERIY,
> Sydpower, Fossibot or any related company. Those names appear only to identify
> the hardware this software talks to.
>
> *kraftverk* is Swedish for "power plant".

---

## Supported models

| Model | Status | Notes |
| --- | --- | --- |
| **AFERIY P280** | ✅ **Verified** | Every setting confirmed against real hardware over BLE. The reference device for this project. |
| AFERIY P210 / P310 | ⚠️ Untested | Same Sydpower stack; listed as supported by other community projects. Expect most things to work. |
| FOSSiBOT F2400 / F3600 / F3600 Pro | ⚠️ Untested | The published register maps were originally derived from these. |
| Eco Play SYD2400 / SYD3600 | ⚠️ Untested | Same stack. |
| ABOK Power Ark3600 | ⚠️ Untested | Same stack. |

If it works with the **BrightEMS** app, it is probably speaking this protocol.

**Untested does not mean compatible.** Several values are known to be
model-specific — the AC charging power scale is 600–1800 W on a P280 but
300–1100 W on an F2400, and the register map has diverged from the published
version in six places on the P280 alone. Assume yours differs until you have
checked it.

The **Protocol** screen exists precisely for this — it lives under a device's
**Settings → Advanced**, because it is a tool for one machine rather than a
property of the app. Dump your registers, compare against
[docs/P280-FINDINGS.md](docs/P280-FINDINGS.md), and open an issue with what
differs.

You pick the model when you add the station, and can correct it afterwards on
its Settings screen; the picker marks which models are verified. The *decoding*
still assumes a P280 — choosing another model records what you have, it does not
yet change how registers are read.

---

## ⚠️ This software can permanently destroy your power station

Read this before running anything.

This project writes directly to a battery management system over an
**undocumented, reverse-engineered protocol**. The failure mode is not a crash
or a bad reading — it is **hardware that never turns on again**.

- **Writing `0` to holding register 68 permanently bricks the station.** Not a
  soft-lock. It does not come back. This is documented by multiple independent
  reverse-engineering efforts, and the vendor's own app removes the option that
  would send it.
- Registers 25 and 26 are reported to *toggle* on any write rather than honour
  the value sent.
- Writing an undocumented register may do anything at all. Nobody has a
  datasheet.

The code has three independent guards against the known brick value — a
register whitelist, a schema, and a test asserting the write is refused — and a
read-only mode that blocks every write at the driver. **None of that makes this
safe.** It makes it less likely that *this* code is what destroys your unit.

**There is no warranty of any kind, and the authors accept no liability for
damage to hardware, property, or anything else.** That disclaimer matters far
more here than for ordinary software: the realistic worst case is not lost data,
it is a dead battery pack worth roughly a thousand euros, and very likely a
voided warranty. Using this software is your decision and your risk alone.

If you are not willing to lose the station, do not run this against it.

Additional cautions:

- Do not change output ports while medical, heating, security, networking or
  other availability-critical equipment is connected.
- Start every session with a new unit in `--read-only`, which is the default for
  the hardware modes.
- **Everyone signs in**, at home too. The first account is created from the
  home network when the app first reaches a fresh server. Keep the server's own
  port and the MQTT broker off the internet; reach it from outside only through
  the web container behind HTTPS. The whole model, and what it does not cover,
  is in [**docs/SECURITY.md**](docs/SECURITY.md).

---

## What it does

- **Live telemetry** — state of charge, power in and out per source and port,
  runtime remaining, AC voltage and frequency, firmware versions.
- **Full settings control** — charge limit, discharge floor, AC charging power,
  silent charging, charge scheduling, DC input type, standby timers, screen
  timeout, light modes, and every output port.
- **Two transports** — a local MQTT broker the station connects to instead of
  the vendor cloud, or a direct Bluetooth LE link. Both carry identical frames.
- **A server is optional.** The app runs in a browser with no server at all, in
  **local mode**: it holds a station's Bluetooth link itself. A kraftverk server
  is something you *add* under App settings by typing its address — one browser
  build, pointed at whichever machine you self-host on, or at none. The address
  list lives in the browser and is fully editable. A server is what buys you
  history, background sampling and, later, automations, because only it is
  running while the app is closed.
- **Or the app holds the link itself** — over Web Bluetooth in a browser, or
  Bluetooth on an iPhone. Same protocol code, same write guards, so the readings
  are identical. What differs is what a connection can *do*: history and
  automations need the server, because only the server is running when the app
  is closed. A client-held link is for watching and controlling a device now,
  not for running one in the background.
- **Protocol diagnostics** — full register dumps, a snapshot/diff workflow for
  identifying unknown registers, and a live frame log.
- **A simulator**, so the app is fully usable with no hardware present.

The app opens on **Your devices** and stays there as you add more. Each saved
device has its own address and exactly two primary screens — Dashboard and
Settings — with model-specific tools such as the P280's register diagnostics
under its Settings, never as a global tab.

| Your devices | Device dashboard | Device settings | Protocol |
| --- | --- | --- | --- |
| ![Your devices](docs/screenshots/devices.png) | ![Dashboard](docs/screenshots/dashboard.png) | ![Settings](docs/screenshots/settings.png) | ![Protocol](docs/screenshots/protocol.png) |

> The screenshots predate the device-first restructuring and still show the old
> tab bar. The screens themselves are the same; where you reach them from is
> not.

---

## How it talks to the station

AFERIY does not write its own firmware stack — it rebadges **Sydpower**, the
platform also behind Fossibot, Eco Play and ABOK. One vendor app (BrightEMS)
drives all of them, which is why reverse-engineering work transfers between
brands. **Search for "Sydpower" and "Fossibot", not AFERIY.**

The station is a **MODBUS RTU slave at address `0x11`**, reachable two ways:

| Transport | Who holds the link | Requires |
| --- | --- | --- |
| `mqtt` | The server — through a broker that runs as its own process, so server restarts do not drop the station ([docs/BROKER.md](docs/BROKER.md)) | BrightEMS's *Local MQTT Broker* setting pointed at your machine, or `mqtt.sydpower.com` redirected to it |
| `ble` | The server — Bluetooth LE GATT | A Bluetooth adapter on the server machine |
| Web Bluetooth | The browser, directly | Chrome or Edge, on `localhost` or HTTPS |
| react-native-ble-plx | The phone, directly | An iOS/Android development build (see below) |

Every one of them carries byte-identical frames, so a single codec, a single
register map and a single write whitelist serve all four. They live in
`packages/protocol`, which the server and the app both import — the app is not
a thin client that trusts the server's decoding, it contains the same decoder.

### The detail that will cost you a day

**The CRC is big-endian**, which contradicts the MODBUS specification. A stock
MODBUS library byte-swaps it and the device silently drops every frame with no
error at all. Verified against three independent captures:

| Frame | CRC | On the wire |
| --- | --- | --- |
| `110400000050` | `0xA6F2` | `a6f2` |
| `1106003f003c` | `0x47BB` | `47bb` |
| 168-byte response | `0xDFB5` | `dfb5` |

### Findings specific to this model

The published register maps were derived largely from **Fossibot F2400/F3600**
hardware. Several things differ on a P280, and trusting the published values
would give you plausible-looking wrong answers:

- **AC charging power** spans 600–1800 W in five steps, not the documented
  300–1100 W.
- **Register 48** is a bitmask reading `0x8040`, not the documented exact
  `0x8000`, so an equality check never sees the charging flag.
- **Register 41 bit 2** is the *inverter*, not AC input. The published mask
  would report a station running on its own battery as grid-connected.
- **The inverter backfeeds the AC input sense line** — 59.1 V at 0 Hz with
  nothing plugged in. Voltage alone cannot be used to detect mains.
- **Registers 15 and 47–50 are undocumented**: DC input type, and the four
  component firmware versions.
- **Register 67 caps AC charging only.** Solar charges straight past it.

Every claim above was verified against real hardware. The evidence for each,
and an explicit list of what remains unverified, is in
**[docs/P280-FINDINGS.md](docs/P280-FINDINGS.md)**.

---

## Getting started

kraftverk is developed on **macOS and Windows**, and both are expected to work
for the full loop — server, web app and BLE. The server also runs on Linux in
Docker; that path is covered in [**docs/DOCKER.md**](docs/DOCKER.md).

### Prerequisites

**Node is the only thing you install.** The rest of the toolchain — the Node
version itself, npm, and Bun — is pinned in `package.json` and comes down with
`npm install`.

- **Node 20.19+**. The project pins **24.19.0**; if you use
  [Volta](https://volta.sh), the `volta` field in `package.json` selects that
  version automatically the moment you `cd` into the repo, and you can skip
  thinking about it.
- **Bun** is a devDependency, not a machine-wide install. `npm install` fetches
  the correct `@oven/bun-<platform>` binary for you. There is no separate
  install step and no `bun upgrade` to keep in sync — the version everyone runs
  is the one in the lockfile.
- **Git**, to clone the thing.

Platform notes:

- **macOS** — for the iOS Simulator you also need Xcode and its Command Line
  Tools (`xcode-select --install`). Everything else works without them.
- **Windows** — you cannot run the iOS Simulator; use **Expo Go** on a phone
  against the same network, or just the web app.

### Install and run

```bash
npm install
```

That single command installs dependencies, downloads the pinned Bun, and builds
the native modules for BLE, serial and USB.

> **On install scripts.** npm 11 refuses to run dependency install scripts
> unless they are approved, which is a good default — but this project genuinely
> needs a few of them, so the packages are listed under `allowScripts` in
> `package.json` and are approved for you. They are the native radio/serial
> bindings (`@stoprocent/noble`, `@stoprocent/bluetooth-hci-socket`,
> `@serialport/bindings-cpp`, `usb`), the bundler (`esbuild`), and Bun itself.
> Nothing else is trusted, and you can see the whole list in one place.

```bash
npm run dev
```

That starts the simulator and the web app — no hardware needed. Open
`http://localhost:8081`.

### Which command to run

Against a real station you choose **how to reach it** and **whether writes are
allowed**. Those are the only two decisions, and they are the two halves of the
script name:

| Command | Reaches the station over | Writes |
| --- | --- | --- |
| `npm run dev` | nothing — the simulator | — |
| `npm run dev:device` | Bluetooth **and** WiFi | refused |
| `npm run dev:ble` | Bluetooth only | refused |
| `npm run dev:wifi` | WiFi only (MQTT on `:1883`) | refused |
| `npm run dev:device:write` | Bluetooth **and** WiFi | **allowed** |
| `npm run dev:ble:write` | Bluetooth only | **allowed** |
| `npm run dev:wifi:write` | WiFi only (MQTT on `:1883`) | **allowed** |

**`dev:device` is the one to reach for.** A station is reachable over whichever
transport it happens to be using, and starting both radios means you do not have
to know which one in advance. A machine with no Bluetooth adapter is fine here —
a transport that cannot start is reported on the Connection screen, and the
other one carries on.

Narrow it only when you want exactly one radio: `dev:ble` leaves the MQTT port
closed, and `dev:wifi` does not touch the Bluetooth adapter.

Everything without `:write` **refuses every write at the driver**. Reach for a
`:write` variant only once you have verified reads against your own unit and
have decided to accept the risk described above.

Each of these frees ports `3333` and `8081` before starting, so a server left
running from last time is not something you have to think about. Port `1883` is
deliberately left alone: that is the MQTT broker, which runs as its own process
and survives server restarts so the station stays connected. The Wi-Fi commands
start it if it is not running. `npm run broker:status` shows it, and
`npm run broker:logs` follows everything the station does —
see [**docs/BROKER.md**](docs/BROKER.md).

To run the server on its own, without Metro, the same names work with a
`server:` prefix — `npm run server:device`, `npm run server:ble:write`, and so
on.

### Running it for real

Everything above is a *development* command: the app is served unminified and
both sides restart the moment a file changes. When you want to **use** the
thing rather than work on it — left running on the machine next to the station
— there is one command:

```bash
npm run start:prod
```

Both radios, writes allowed, the app bundled in production mode, and neither
side restarting under you. It is `dev:device:write` with the development parts
taken out.

It is also **the most dangerous way to run this software**, and the server says
so on startup: full hardware access with writes enabled and no read-only net.
Do not reach for it until you have read the hardware warning above and verified
reads against your own unit.

`start:prod` runs on the **host**, not in Docker. A container has no honest
access to a Bluetooth radio — which is why the image leaves noble out
altogether — so "all transports" is something only a host process can offer.
For an always-on server reaching stations over WiFi, use Docker instead.

### Running the server in Docker

For a machine that is always on — which is what buys you history and, later,
automations:

```bash
docker compose up -d --build
```

Then open `http://<that-host>:8080`: the app, served beside the server, which
asks you to create the first administrator. Three containers — the app, the
server, and the MQTT broker, kept apart so that updating the server does not
drop the station. It ships the simulator with writes refused by default, and
Bluetooth is deliberately not in it — a container has no honest access to a
radio, and MQTT is the transport that suits a server anyway.
[**docs/DOCKER.md**](docs/DOCKER.md) covers the transport choice, secrets,
reaching it from outside over HTTPS, backups, updating without dropping the
station, and diagnosing a problem.

### Connecting over Wi-Fi

1. Start with `npm run dev:device` (or `dev:wifi`). The server starts the MQTT
   broker on `:1883` if one is not already running.
2. Point the station at your machine, one of two ways:
   - **BrightEMS 1.6.0+**: *Me → Settings → Local MQTT Broker Settings*, and
     enter your machine's LAN IP. Only the master account can change it. This is
     how the P280 in [P280-FINDINGS.md](docs/P280-FINDINGS.md#connection-over-wi-fi)
     was connected.
   - **Older firmware**: redirect the vendor hostname in your router or Pi-hole —
     `mqtt.sydpower.com -> <your machine's LAN IP>` — and power-cycle the
     station so it re-resolves DNS.
3. Watch it arrive: `npm run broker:logs` shows the TCP connection, the MQTT
   handshake and the station's first frames as they happen.
4. Add it under **Your devices → Add a device → Power stations → AFERIY P280 →
   Wi-Fi, through your server**. The station is listed once it has connected
   to the broker — it also appears under **Found near you** on the home
   screen — and the check reads it once before it is saved. Nothing is adopted
   for you: a device exists because you added it.

The station still needs internet on first connect — it fetches MQTT credentials
from the vendor cloud before connecting. Only the MQTT traffic is redirected.

**Keep the broker running.** A P280 that loses its broker for more than a short
while can stop trying to reconnect until it is power-cycled. That is why the
broker is a separate process that server restarts do not touch;
`npm run broker:stop` and `broker:restart` are the only things that stop it.

Windows Firewall usually blocks the inbound connection:

```bash
netsh advfirewall firewall add rule name="kraftverk MQTT" dir=in action=allow protocol=TCP localport=1883 profile=private
```

### Connecting over Bluetooth

```bash
npm run dev:ble
```

**Close the vendor app first.** These stations accept one BLE connection at a
time, and while the phone holds it, Windows sees only the generic GATT services
and the vendor service is invisible. Pairing is *not* required. Then add it as
**Bluetooth, through your server**.

### Connecting from this phone or browser

A connection can be held by the app instead of the server: add the station as
**Bluetooth, from this browser** (or *from this phone*). The app then runs the
station's own session — the same device-type and protocol code the server runs,
with the same register-68 guard — over its own radio, and sends its readings to
the server, which records them as history while the app has the station. The
device's **Settings → Connections** says who holds what; a station reached both
ways uses the connection highest in that list that is reachable, so the server's
Wi-Fi takes over again when the phone leaves.

With **no server at all** — local mode — the app keeps its own devices and
reaches them itself. Nothing is recorded, and nothing runs while it is closed.
It is where the app starts when there is no server beside it; adding one in
**App settings** switches to it.

- **In a browser**: Chrome or Edge, on `localhost` or over HTTPS. The browser
  shows its own device chooser; a page is not allowed to scan. Safari and
  Firefox have no Web Bluetooth, and the add screen says so.

  Two refusals come from the browser rather than from this app:

  - **"Web Bluetooth API globally disabled."** Brave ships it switched off —
    enable `brave://flags/#brave-web-bluetooth-api`. On Chrome or Edge check
    `chrome://flags/#enable-web-bluetooth`, and `chrome://policy` for a
    `DefaultWebBluetoothGuardSetting` set by an organisation.
  - **The chooser closes instantly, reporting "User cancelled".** Browsers
    embedded inside another app usually have no chooser UI. Open the app in a
    real Chrome or Edge window.

  A browser remembers a station it was shown once, so a reload reconnects
  without the chooser where Chrome keeps that permission.
- **On a phone**: needs a development build, because Bluetooth is a native
  module and Expo Go cannot load one.

  ```bash
  npm install react-native-ble-plx --workspace client
  ```

  Then add the usage strings iOS requires (`NSBluetoothAlwaysUsageDescription`)
  to `client/app.json` and run `npx expo run:ios`. Without the library the app
  still builds and runs — Metro resolves it to nothing and the add screen
  explains what is missing.

**Writes from the app are refused** until **App settings → Allow writes from
this app** is turned on, and that switch is off again every time the app
starts. The whitelist and the brick-value guard apply regardless: they are in
the station's package and its protocol, not in either front end.

The single-connection rule still bites: while the app holds a station's
Bluetooth, nothing else can.

---

## API

Base URL: `http://<host>:3333/api` — or, in Docker, through the web container:
`http://<host>:8080/api`.

Every route passes one gate: a session cookie, reads and writes alike, from any
network. Only the sign-in routes are open, and `/health` answers the server's own
machine. Every request that changes anything must carry an `X-Kraftverk-Client`
header. See
[docs/SECURITY.md](docs/SECURITY.md).

Everything is device-scoped: a route names the device it acts on. `:id` is an
opaque catalog id (`d-3db445e0a1b2`; older ones look like
`power-station:3db445e0`), so URL-encode it. A device's own permanent id — its
MAC, a Tuya device id — is `identity`, a separate field: it is how the same
device is recognised however it is found, and why removing one and adding it
again can bring its history back. Health is not a boolean: `health.status` is
one of `connected`, `connecting`, `offline`, `unconfigured` or `error`, and
always comes with a sentence in `health.detail`. Nothing here names a device
type: a type's own tools are its `advanced` actions.

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
| `GET` | `/devices` · `/devices/removed` | The devices you have, with live readings, health, connections and links; removed ones, with their history |
| `GET` `PATCH` `DELETE` | `/devices/:id` | Read, rename, or remove — keeping its history |
| `POST` | `/devices/:id/delete-history` | Delete a removed device and everything it recorded; its name, typed, confirms it |
| `GET` `PATCH` | `/devices/:id/settings` | A device's own settings, from the schema it publishes |
| `POST` | `/devices/:id/capabilities/:capability/:command` | Every command — through the action gateway; a refusal says `needsConfirmation` when a person only has to confirm |
| `GET` `POST` | `/devices/:id/advanced/:name` | A device type's own tools: register dump, snapshot, scan, raw frame. Reads are GETs; writes are refused while read-only and audited |
| `GET` | `/devices/:id/history` | One measurement over time, thinned for a chart |
| `POST` `DELETE` | `/devices/:id/connections/:connection` (`/prefer`) | Prefer one way to reach it, or remove one — not the last |
| `PUT` | `/devices/:id/connections/:connection/secrets` | Replace a server-held connection's secrets, such as a plug's new local key |
| `POST` `DELETE` | `/links` · `/links/:id` | Facts about the house: this plug feeds that station |
| `GET` `POST` `DELETE` | `/clients` · `/clients/:id` | The phones and browsers that hold connections |
| `POST` | `/devices/:id/readings` · `/clients/:id/audit` | What an app sends for a connection it holds |
| `GET` `PUT` | `/devices/:id/store` · `/devices/:id/store/:key` | A device's own store, for a session an app runs |
| `GET` | `/transports` · `/transports/:id/diagnostics/:name` | What this server reaches devices over, and each transport's diagnostics — the broker, its journal, its traffic |
| `GET` | `/found` | What the transports see that nothing you have is reached by |
| `GET` | `/diagnostics/log` | The server's own recent log (`?level=warn`, `?limit=`), and where its daily files are |
| `GET` | `/audit` | The timeline: intents, commands, verification outcomes |

### Environment

| Variable | Flag | Default | Meaning |
| --- | --- | --- | --- |
| `STATION_DRIVER` | `--driver=` | `sim` | `sim` reaches no hardware; `device` means Bluetooth and MQTT; or a list, `mqtt`, `ble,mqtt`. Every hardware mode also has the home network (`lan`) and `https` |
| `KRAFTVERK_TRANSPORTS` | — | — | Names the transports outright instead: `mqtt,lan,https` |
| `READ_ONLY` | `--read-only` | on for hardware modes | Refuse every write |
| `PORT` / `HOST` | — | `3333` / `0.0.0.0` | HTTP API |
| `MQTT_PORT` / `MQTT_HOST` | — | `1883` / `0.0.0.0` | Where the MQTT broker listens for stations |
| `BROKER_HOST` / `BROKER_ADMIN_URL` | — | `127.0.0.1` / `http://127.0.0.1:3883` | Where the server reaches the broker |
| `BROKER_SPAWN` | — | on | `0` stops the server starting a broker, for when it runs as its own service. The rest of the broker's settings are in [docs/BROKER.md](docs/BROKER.md#environment) |
| `ALLOWED_ORIGINS` | — | — | Browser origins allowed to call the API with your session, comma-separated. Not needed for the web container (same origin) or the native app; in development the Expo dev server on a private address is allowed on its own. `*` is refused |
| `KRAFTVERK_ALLOWED_HOSTS` | — | — | Names the server answers to besides addresses and local names, such as a DDNS name. Others get `421` (DNS-rebinding defence) |
| `KRAFTVERK_TRUSTED_PROXIES` | — | — | The web container, whose home-network/public entrance stamp is believed. See [docs/SECURITY.md](docs/SECURITY.md) |
| `ALLOW_RAW_FRAMES` (or `ALLOW_RAW_MODBUS`) | — | — | `1` lets a device type's raw-frame tool send frames nobody has described. The protocol's guard still applies |
| `KRAFTVERK_DB` | — | `server/data/kraftverk.db` | Where the database lives. **Required under `NODE_ENV=test`** — the server refuses to open the default file from a test run |
| `KRAFTVERK_RESET_SECRET_FILE` | — | `server/data/reset-secret` | A passphrase of 16+ characters here lets the app empty the database from **App settings → Danger zone**. No file means the route does not exist; the app shows how to enable it rather than a dead button. Gitignored |
| `KRAFTVERK_SECRET_KEY` | — | — | Passphrase for AES-256-GCM secrets, such as a plug's local key. Without it they are stored as given, and the UI says so |

---

## Identifying unknown registers

The **Protocol** screen — under a device's **Settings → Advanced** — implements
the workflow that produced everything in the findings document:

1. **Snapshot baseline** — captures all 160 registers
2. Change **one** thing on the station itself
3. **Dump registers**, then **Show changed only**

Whatever moved is the register behind that control. One change at a time, or the
diff stops being evidence. Note that USB switches itself off after about three
minutes with no load, so take the second dump promptly.

Two things that workflow taught us, worth knowing before you trust a hypothesis:

- **Two registers sharing a value proves nothing.** Three separate "mirror
  register" theories died this way.
- **A write can change a register you did not write.** Switching DC input type
  also moved the charging-current ceiling.

---

## Tests

```bash
npm test
```

The protocol tests — frame construction, response parsing, telemetry
decoding against captured traffic from real hardware, plus the write-safety
whitelist and the behaviours confirmed on a P280 — live with the protocol
package, so they cover every link equally: a direct Bluetooth connection from
the app runs the code these tests exercise. The rest cover the catalog, the
connection manager, the action gateway, the device registry, the MQTT broker,
history, and accounts and sign-in, written as attacks — and the HTTP routes
themselves, through `createApp` in `server/src/app.ts`, which builds the whole
API around the simulator and a throwaway database without starting a radio or
a broker.

Every push also checks the architecture — no device-specific code may leak
into the core, and the count of what already has may only fall
([docs/ARCHITECTURE.md §7](docs/ARCHITECTURE.md#7-guardrails-in-ci)) — and
builds both Docker images, starts the stack and attacks it —
on GitHub and on GitLab alike. See [docs/CI.md](docs/CI.md).

**Server tests must set `KRAFTVERK_DB`.** Bun runs every test file in one
process, sharing the database handle, and several suites begin by deleting from
`device` and `sample`. A suite that reaches the default file would truncate the
owner's catalog — it has happened — so `db()` now throws rather than open it
under `NODE_ENV=test`.

---

## Project layout

The layout is ARCHITECTURE.md §3:

```
packages/device-sdk/     the contract: categories, capabilities, links, connection methods, transports, protocols
packages/gateway/        the action gateway's rules, run by whoever holds a connection
packages/protocols/      sydpower (the station), tuya-local (the plugs), open-meteo — pure
packages/transports/     mqtt (the broker), ble, lan, https — one entry per place it runs
packages/devices/        aferiy-p280, tuya-plug, atorch-s1w — what each device is
packages/services/       open-meteo — weather, a service
packages/ui/             shared interface primitives, used by the app and by devices
packages/api-client/     every API endpoint, and the shapes the server sends
client/                  Expo app (iOS + web)
  app/index.tsx          "Your devices" — the root, always
  app/add-device.tsx     categories → type → how to connect → steps → check → save
  app/device/[id]/       one device: dashboard, settings, advanced
  src/runtime/           this app as a holder: sessions, gateway, uploads, local mode
  src/generated/         the installed packages, bound in by npm run gen:devices
server/
  src/runtime/           finding packages; the transports this server runs
  src/devices/           catalog, connections, links, sessions, setup, registry
  src/routes/            the HTTP API
  src/history/           sqlite, migrations, samples, the audit timeline
docs/HANDOFF.md          state of play, and the traps worth knowing — start here
docs/ARCHITECTURE.md     the architecture, its words and the plan: the authority
docs/DATA-MODEL.md       adding a device screen by screen, and everything stored
docs/ADDING-A-DEVICE.md  supporting a new product: the packages, the contract, the rules
docs/PROJECT-BRIEF.md    what the product is for, its safety rules and the automation
docs/P280-FINDINGS.md    the station: evidence log, confirmed vs. assumed
docs/ATORCH-S1W.md       the smart plug and the Tuya local protocol: research and findings
docs/TUYA-LOCAL-KEY.md   five-minute guide to getting a plug's local key
docs/BROKER.md           the MQTT broker the station connects to
docs/DOCKER.md           running the server in a container
docs/SECURITY.md         accounts, sign-in and every defence, checkably
docs/ACCOUNTS.md         where accounts are going: homes, sharing, the hosted service
docs/CI.md               what every push checks
```

### Connecting a smart plug

```bash
npm run scan:tuya
```

finds Tuya plugs on your network — no credentials needed — and reports each one's address and
protocol version.

```bash
npm run keys:tuya
```

fetches their local keys, which is the one step that needs a (free) Tuya cloud project. Both are
also part of adding the plug in the app — the plug is found on the home network, and **Fetch it
with my Tuya account** is a button on its credentials step — driven by the same code.
[docs/TUYA-LOCAL-KEY.md](docs/TUYA-LOCAL-KEY.md) walks through it.

Every package is imported as TypeScript source with no build step, by both the
server (under Bun) and the app (through Metro).

---

## Credits

This builds directly on other people's work:

- **[schauveau/sydpower-mqtt](https://github.com/schauveau/sydpower-mqtt)** —
  the most complete MQTT + MODBUS specification, and the primary source here
- **[iamslan/ha-fossibot](https://github.com/iamslan/ha-fossibot)** — Home
  Assistant integration; source of the writable-register whitelist
- **[dandwhelan/fossibot-bluetooth](https://github.com/dandwhelan/fossibot-bluetooth)** —
  BLE protocol and GATT UUIDs
- **[ylianst/esp-fbot](https://github.com/ylianst/esp-fbot)** — ESP32 BLE bridge
- **[bootuz-dinamon/Aferiy-Fossibot-Reverse-Engineering](https://github.com/bootuz-dinamon/Aferiy-Fossibot-Reverse-Engineering-)** —
  RS485 approach, and the only source naming the P280
- **[Jack Reeve — Reverse Engineering my smart battery](https://medium.com/@jack_57343/reverse-engineering-my-smart-battery-c01d711c770b)** —
  the write-up that established how the vendor app reaches the cloud

## Legal

Reverse engineering a device you own for interoperability is generally lawful in
the EU and US. Everything here targets hardware on your own network. Do not
point it at anyone else's.

## Licence

MIT — see [LICENSE](LICENSE). Note in particular the warranty and liability
disclaimers, and the hardware warning at the top of this file.
