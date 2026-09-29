# Running kraftverk

Everything about starting it: on your own machine for development, left
running for real, or in Docker. Device-specific steps — pointing a power
station at the broker, fetching a plug's key — are with each device type,
linked from the [README](../README.md#supported-devices).

## Getting started

kraftverk is developed on **macOS and Windows**, and both are expected to work
for the full loop — server, web app and BLE. The server also runs on Linux in
Docker; that path is covered in [**docs/DOCKER.md**](DOCKER.md).

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

That starts the server and the web app. Open `http://localhost:8081`, and
add a device: every type can be added **Simulated**, which needs no hardware —
its simulator stands in for it, beside any real device you add later.

### Which command to run

There is one decision: **whether writes to hardware are allowed**. How a device
is reached is not a way of starting the server — every installed transport is
available (Bluetooth, Wi-Fi through the MQTT broker, the home network, HTTPS),
and each device is reached the way you added it. A transport that cannot run on
this machine — no Bluetooth adapter — says so on the Connectivity screen and on
every connection over it, and the others carry on.

| Command | Writes to hardware |
| --- | --- |
| `npm run dev` | refused |
| `npm run dev:write` | **allowed** |

Without `:write` the server **refuses every write to hardware**. Simulated
devices reach no hardware and take writes either way. Reach for `:write` only
once you have verified reads against your own unit and have decided to accept
the risk described in the
[station's hardware warning](../packages/devices/aferiy-p280/README.md#this-software-can-permanently-destroy-your-power-station).

Each of these frees ports `3333` and `8081` before starting, so a server left
running from last time is not something you have to think about. Port `1883` is
deliberately left alone: that is the MQTT broker, which runs as its own process
and survives server restarts so the station stays connected. The server starts
it if it is not running. `npm run broker:status` shows it, and
`npm run broker:logs` follows everything the station does —
see [**docs/BROKER.md**](BROKER.md).

To run the server on its own, without Metro: `npm run server`, or
`npm run server:write`.

### Running it for real

Everything above is a *development* command: the app is served unminified and
both sides restart the moment a file changes. When you want to **use** the
thing rather than work on it — left running on the machine next to the station
— there is one command:

```bash
npm run start:prod
```

Writes allowed, the app bundled in production mode, and neither side
restarting under you. It is `dev:write` with the development parts taken out.

It is also **the most dangerous way to run this software**, and the server says
so on startup: full hardware access with writes enabled and no read-only net.
Do not reach for it until you have read the [hardware warning](../packages/devices/aferiy-p280/README.md#this-software-can-permanently-destroy-your-power-station) and verified
reads against your own unit.

`start:prod` runs on the **host**, not in Docker. A container has no honest
access to a Bluetooth radio — which is why the image leaves noble out
altogether — so Bluetooth is something only a host process can offer.
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
drop the station. It ships with writes to hardware refused by default, and
Bluetooth is deliberately not in it — a container has no honest access to a
radio, and MQTT is the transport that suits a server anyway.
[**docs/DOCKER.md**](DOCKER.md) covers reaching devices, secrets,
reaching it from outside over HTTPS, backups, updating without dropping the
station, and diagnosing a problem.

## Connecting from this phone or browser

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

## Connecting a smart plug

```bash
npm run scan:tuya
```

finds Tuya plugs on your network — no credentials needed — and reports each one's address and
protocol version.

```bash
npm run keys:tuya
```

fetches their local keys, which is the one step that touches Tuya's cloud: you scan a QR code with
the Smart Life app, and no developer account is needed (`--developer` uses a Tuya cloud project
instead). Both are
also part of adding the plug in the app — the plug is found on the home network, and **Fetch it
with my Tuya account** is a button on its credentials step — driven by the same code.
[docs/TUYA-LOCAL-KEY.md](TUYA-LOCAL-KEY.md) walks through it.
