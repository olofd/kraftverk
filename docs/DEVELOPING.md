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
API around the simulator and a throwaway database without starting a radio or
a broker.

Every push also checks the architecture — no device-specific code may leak
into the core, and the count of what already has may only fall
([docs/ARCHITECTURE.md §7](ARCHITECTURE.md#7-guardrails-in-ci)) — and
builds both Docker images, starts the stack and attacks it —
on GitHub and on GitLab alike. See [docs/CI.md](CI.md).

**Server tests must set `KRAFTVERK_DB`.** Bun runs every test file in one
process, sharing the database handle, and several suites begin by deleting from
`device` and `sample`. A suite that reaches the default file would truncate the
owner's catalog — it has happened — so `db()` now throws rather than open it
under `NODE_ENV=test`.

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
  src/history/           sqlite: the one schema, samples, roll-ups, the audit timeline
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
