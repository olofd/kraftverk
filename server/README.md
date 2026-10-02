# kraftverk-server — a home's HTTP entrance

## What it is

The kraftverk node that runs on an always-on machine — a NAS, a small
server — and lets people and their apps in over HTTP. It is a process,
not a package: it runs one home (`@kraftverk/hub`'s `createHub`) over a
SQLite file, and adapts every route to that home's one interface,
`KraftverkApi`.

## What it does — and does not

- **Does:** the HTTP API and its live socket, each route a thin adapter
  from a request to `hub.as(caller)`; accounts, sign-in and the gate in
  front of every route; what is on its disk — the database file, its
  secret key, the configuration kept beside it, the packages installed;
  and the process — starting, stopping, its log.
- **Does not:** decide anything about a home. What a device is, what the
  gateway allows, how an automation runs, what an import plans: all of it
  is the shared packages', the same code a phone or a browser runs. The
  architecture check refuses logic here outside the places below
  (`npm run check:architecture`).

## Where it fits

An edge (docs/PLAN-SHARED-CORE.md), beside the app: it builds the hub from
what only it can give — bun:sqlite, Node's file system, the transports it
can start (MQTT's broker, the LAN, HTTPS) — and serves it. Followers — an
app holding a device over its own Bluetooth — join the home through it.

## Why a package of its own

Because a home needs somewhere always on: to keep history while every
phone is asleep, to hold what only the network reaches, and to be the
master other nodes follow. Everything that place needs and a phone does
not — accounts, a port, a disk — is here, so no shared package carries it.

## In detail

```
src/
  index.ts        the process: config, log, database, what is installed, the hub, serve, stop
  app.ts          createApp: middleware, the gate, mounting the routes, the error answer
  config.ts       everything read from the environment, once; what this server is (name, version)
  log.ts          the console, kept: recent lines for /diagnostics/log, daily files
  routes/
    context.ts    AppDeps, homeFor (the home as the caller asks it), shapes several routes take
    parse.ts      a body or a query checked against its shape; refused as the home refuses
    server.ts     /health, /version, /diagnostics/log, /admin/reset — the server's own
    home.ts       /home, /nodes, /policy, /audit
    devices.ts    device types, devices and how each is reached, /problems
    links.ts      /links
    setup.ts      adding a device, step by step
    followers.ts  what a follower sends for the ways it holds: /setup/held, readings, store, audit
    transports.ts /transports, /found, a transport's diagnostics
    automations.ts, configuration.ts, live.ts, assistant.ts (the MCP endpoint is the hub's)
  auth/           accounts (their tables: schema.ts), sign-in, the gate, who is at home, guessing
  platform/       the database file, this node's id, finding packages on disk, secrets at
                  rest, the configuration kept, the reset passphrase, HTTP for packages
```

Run it with `npm run dev` (read-only) or `npm run dev:write` from the
repository root; `docs/DEVELOPING.md` has the rest, `docs/DOCKER.md` the
container.
