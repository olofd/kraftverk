# Aferiy Powerstation

A monorepo prototype for monitoring and controlling an Aferiy portable power station.

- **`client/`** — Expo (React Native + react-native-web) app with Tamagui and expo-router. Runs on iOS and in the browser from one codebase.
- **`server/`** — Hono API server written in TypeScript, run by Bun.

The server currently simulates a station. Everything the client talks to is a
real HTTP API, so swapping the simulator for real hardware is a change confined
to `server/src/station.ts`.

## Prerequisites

You are developing on Windows, which shapes two things:

1. **Node 20.19+ (22 LTS recommended)** is needed for Expo and Metro.
   Check with `node -v`. If it prints anything below 20, install a current
   version — Expo SDK 57 will not run otherwise.
2. **You cannot run the iOS Simulator on Windows.** iOS testing happens on a
   physical iPhone through the **Expo Go** app on the same Wi-Fi network.

Install Bun for the server (PowerShell):

```bash
powershell -c "irm bun.sh/install.ps1 | iex"
```

## Install

Dependencies for both packages are installed once from the repo root. npm
workspaces handles the hoisting; Bun is used purely as the server's *runtime*,
so there is only one lockfile.

```bash
npm install
```

Then let Expo align the native package versions with the installed SDK:

```bash
npx expo install --fix --project-root client
```

## Run

Both at once:

```bash
npm run dev
```

Or separately:

```bash
npm run server
```

```bash
npm run web
```

- **Web** — Expo prints a `http://localhost:8081` URL. Open it.
- **iOS** — run `npm start`, then scan the QR code with the Camera app and open
  it in Expo Go. The app resolves the API host from Expo's own dev-server
  address, so it finds your Windows machine over the LAN automatically.

If the phone can't reach the API, it is almost always Windows Firewall. Allow
inbound TCP on port `3333` for private networks, or run:

```bash
netsh advfirewall firewall add rule name="Aferiy API" dir=in action=allow protocol=TCP localport=3333 profile=private
```

## API

Base URL: `http://<host>:3333/api`

| Method  | Path            | Purpose                                             |
| ------- | --------------- | --------------------------------------------------- |
| `GET`   | `/health`       | Liveness check                                       |
| `GET`   | `/version`      | Server name, version, runtime, uptime                |
| `GET`   | `/status`       | Live telemetry: charge, watts in/out, temp, ports    |
| `GET`   | `/settings`     | Current station settings                             |
| `PATCH` | `/settings`     | Update any subset of settings (zod-validated)        |
| `POST`  | `/ports/:id`    | Toggle an output port (`ac` \| `dc` \| `usb`)        |
| `POST`  | `/grid`         | Dev-only: simulate connecting/disconnecting the wall |

Settings persist to `server/data/settings.json` (gitignored).

## Configuration

The client resolves the API base URL automatically. To point it somewhere else,
set an env var before starting Expo:

```bash
set EXPO_PUBLIC_API_URL=http://192.168.1.50:3333/api
```

`EXPO_PUBLIC_API_PORT` overrides just the port (default `3333`).

Server env vars: `PORT` (default `3333`), `HOST` (default `0.0.0.0`).

## Project layout

```
client/
  app/                     expo-router routes
    _layout.tsx            providers: Tamagui, safe area, station state
    (tabs)/
      _layout.tsx          tab bar
      index.tsx            dashboard
      settings.tsx         station settings
  src/
    components/            Card, Row, SliderRow, SegmentedControl, …
    lib/                   api client, shared types, formatters
    state/                 StationProvider — one poll loop for the whole app
  tamagui.config.ts        tokens, light/dark themes, fonts, animations
server/
  src/
    index.ts               Hono routes
    station.ts             station model (simulated; hardware seam marked)
    types.ts               zod schemas — the source of truth for the API
```

## Notes and next steps

- `client/src/lib/types.ts` mirrors `server/src/types.ts` by hand so Metro never
  resolves outside `client/`. Once the API stabilises, replace it with Hono's
  RPC client (`hc<AppType>`) for end-to-end types with no duplication.
- The client polls `/status` every 2s and pauses while backgrounded. If update
  latency starts to matter, move to SSE (`hono/streaming`) — it will need an
  `EventSource` polyfill on React Native.
- CORS is wide open for local development. Lock it to an allowlist before this
  is reachable from anywhere but your own network.
