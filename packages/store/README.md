# @kraftverk/store — a home's data in SQLite

## What it is

kraftverk's data model (docs/DATA-MODEL.md) as one SQLite schema and the
stores that keep to it. The server keeps a home in a file through
bun:sqlite; the app will keep one on a phone through expo-sqlite, and in a
browser through sql.js — the same schema and the same stores, so a home
reads the same wherever it is kept.

## What it does — and does not

- **Does:** the schema and whether a database has it; every store that
  keeps only data — devices, connections and their sealed secrets, links,
  events, apps, automations and their runs, what a device and a transport
  keep, the gateway's memory, policy, decisions, the timeline — each made
  from a database; and the ports the packages below declare, filled in
  SQLite.
- **Does not:** open a file, set an old one aside, or hold a key: those are
  the place's (the server's `platform/`, the app's). Nor does it decide
  anything about what it keeps: logic that mixes storage with judgement —
  sampling history, the change log — is the hub's.

## Where it fits

Above the runtime, under the hub (docs/PLAN-SHARED-CORE.md): it keeps what
the engine and the holder declare they need, and the hub wires it to the
rest.

## Why a package of its own

Because a home's data must be kept the same way on a server and on a
phone: one schema, one set of stores, tested on each SQLite it will run on,
with nothing at module level so two homes can be open in one process.

## In detail

Pure. Two ports, filled by the place that keeps the home:

- **`SqlDatabase`** — `query(sql)` with `get`, `all` and `run`, `exec`,
  `transaction` (nesting as savepoints) and `close`; synchronous, as
  bun:sqlite and expo-sqlite are. bun:sqlite's `Database` is the port as it
  stands; `fromSqlJs` makes a sql.js database one.
- **`SecretsAtRest`** — how a connection's secrets are sealed: the server's
  key from its environment, a phone's from its secure storage;
  `plainSecrets` keeps them as given.

Every store is made from the database it keeps to — nothing at module
level — so two homes can be open in one process.

| | |
|---|---|
| The schema | `SCHEMA`, `schemaFingerprint`; `prepareDatabase`, `schemaStateOf` (current, empty, or another — set aside by the place, strict version 1), `createSchema`, `metaOf`, `resetDatabase` |
| Devices | `DeviceCatalog`, `ConnectionStore` (with sealed secrets), `LinkStore`, `EventStore`, `ClientStore` (apps that hold connections) |
| What a device and a transport keep | `deviceStore`, `transportStore` |
| The gateway's memory | `databaseLedger` — the last switch of a part, the last write of a setting |
| Automations | `AutomationStore`, the engine's `AutomationStorage` |
| The home | `AppState` (decisions), `policyValues` and `setPolicyValue`, `AuditLog` (the timeline) |
| Ids | `randomHex` — from the random values every place has |

Its tests run on bun:sqlite and on sql.js (`test/drivers.ts`).
