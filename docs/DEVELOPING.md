# Developing kraftverk

The tests, what every push checks, and where everything lives. Adding support
for a product is its own guide: [ADDING-A-DEVICE.md](ADDING-A-DEVICE.md).

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
API around simulated devices, a pretend bus and a throwaway database without
starting a radio or a broker.

Every push also checks the architecture — no device-specific code may leak
into the core, and the count of what already has may only fall
([docs/ARCHITECTURE.md §7](ARCHITECTURE.md#7-guardrails-in-ci)) — and
builds both Docker images, starts the stack and attacks it —
in the pipeline on Forgejo. See [docs/CI.md](CI.md).

### End to end, in a browser

```bash
npm run test:e2e
```

Playwright drives the app as a person does — adding a device, answering
what it is linked to, making an automation, confirming a consequential
command, the app with no server — against the **real server**, started on a
port and a database of its own, read-only, with every device added through
the **Simulated** method. The server holds a simulated device exactly as it
holds a real one: setup, sessions, the gateway, history, the live stream and
automations all run; only the hardware is not there. The app is the web
build as it ships, served same-origin by `e2e/serve.mjs` with `/api` and the
live socket passed through, as the web container serves it. The tests are
`e2e/*.e2e.ts` — not `*.spec.ts`, which Bun's runner would pick up.

Simulated devices behave as a home of them would: a simulated plug that
feeds a simulated station (a `feeds` link) is its mains — on, it charges;
off, it runs on its battery — and a simulated type can be set up as the
device you mean (a P280's charge to start from, its packs, its load).

**Time, simulated.** A second server runs beside it with its home's clock
2000 times real time (`KRAFTVERK_CLOCK_RATE`, which a server that is not
read-only refuses: every pause that protects a relay would be that much
shorter too). Everything that keeps time keeps that one clock (`Clock`, in
`@kraftverk/device-sdk`): the automation engine's holds and ticks, the
gateway's pause between switches and how fresh a reading must be, the
holder's looks at its devices, and the simulators' batteries. A test of what
happens over hours lives through them in seconds, over the API (`fastServer`
in `e2e/helpers.ts`): `keep-between.e2e.ts` keeps a simulated P280 between 5
and 30 % through the plug that feeds it — 2-minute holds, two whole cycles,
six hours — in about 12 seconds.

`npm run test:e2e` builds the app first (`E2E_SKIP_BUILD=1` reuses
`client/dist`); `-- --headed` or `-- --ui` pass through to Playwright. The
first run needs its browser: `npx playwright install chromium`. On a failure,
`e2e-results/` has a screenshot, a trace and the page as the test saw it.

What these do not reach yet is below the device: `identify`, the protocols'
framing and the transports run in their unit tests against scripted bytes.
Fakes on the wire — a pretend plug speaking tuya-local on a local port, a
pretend station speaking Sydpower to a test broker, built from recorded
sessions — will let the same tests run all the way down (NEXT-STEP phase 7).

**Each server test opens a database of its own.** Nothing in the server keeps
a database handle: the process opens it once (`openDatabase` in `index.ts`)
and hands it on, and a test opens its own — a temp file, or `:memory:`.
Several suites begin by deleting from `device` and `sample`, and one that
reached the default file would truncate the owner's catalog — it has happened —
so `openDatabase` refuses the default path under `NODE_ENV=test`.

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
  src/platform/home/     the home, where the app runs: its own, or what it holds for a server — in its process on a phone, in a worker in a browser
  src/platform/          what is the app's own and not a screen: its preferences, its cipher, where it runs
  src/state/             the home the screens ask (HomeProvider), its devices, the servers
  src/generated/         the installed packages, bound in by npm run gen:devices
packages/hub/            a home, running: what is installed, devices' views, setup, history, attention
server/
  src/platform/          the file the home is kept in, its secret key, finding packages on disk
  src/routes/            the HTTP API
  src/auth/              accounts, sign-in, and the gate in front of every route
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
docs/RUNNING.md          every way to start it, and connecting from a phone or browser
docs/API.md              every endpoint and environment setting
docs/DEVELOPING.md       this file
docs/PRODUCT.md          what kraftverk is for, next to Home Assistant, and the plan
```

Every package is imported as TypeScript source with no build step, by both the
server (under Bun) and the app (through Metro).
