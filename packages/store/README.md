# @kraftverk/store — a home's data in SQLite

## What it is

kraftverk's data model (docs/DATA-MODEL.md) as one SQLite schema and the
stores that keep to it. The server keeps a home in a file through
bun:sqlite; the app keeps one on a phone through expo-sqlite, and in a
browser through SQLite's own WebAssembly build, in a worker — the same
schema and the same stores, so a home reads the same wherever it is kept.
What a place keeps beside the home in the same file — a server's accounts
— is the place's, not the store's.

## What it does — and does not

- **Does:** the schema and whether a database has it; every store that
  keeps only data — devices, connections and their sealed secrets, links,
  events, the home with its nodes and places, automations and their runs,
  what a device and a transport keep, the gateway's memory, policy,
  decisions, the timeline — each made from a database; and the ports the
  packages below declare, filled in SQLite.
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
  bun:sqlite and expo-sqlite are. The server fills it from bun:sqlite's
  `Database`, keeping its own statements; `fromSqliteWasm` makes one of SQLite's WebAssembly build
  (`@sqlite.org/sqlite-wasm`, a browser's) one — described, not imported,
  so the store depends on no build of it.
- **`SecretsAtRest`** — how a connection's secrets are sealed:
  `sealedWithKey(key)`, the one cipher every place seals with (AES-256-GCM
  in plain JavaScript), with the key the place keeps — the server's made
  from its passphrase (`secretKeyFrom`), a phone's in its secure storage;
  `plainSecrets` keeps them as given.

Every store is made from the database it keeps to — nothing at module
level — so two homes can be open in one process.

| | |
|---|---|
| The schema | `SCHEMA`, `schemaFingerprint`; `prepareDatabase`, `schemaStateOf` (current, empty, or another — set aside by the place, strict version 1), `createSchema`, `metaOf`, `resetDatabase` |
| Devices | `DeviceCatalog`, `ConnectionStore` (with sealed secrets), `LinkStore`, `EventStore`, `HistoryStore`, `TrackStore` (where a device has been, while its owner keeps it) |
| Nodes | `FamilyStore` (the family this database is, and its master node), `NodeStore` (every kraftverk node of the family: this database's own, and the nodes that joined it) |
| What a device and a transport keep | `deviceStore`, `transportStore` |
| The gateway's memory | `databaseLedger` — the last switch of a part, the last write of a setting |
| Automations | `AutomationStore`, the engine's `AutomationStorage` |
| The home | `HomeSettings` (what this node has settled for it, by name), `policyValues` and `setPolicyValue`, `AuditLog` (the timeline) |
| What a node following the master keeps | the master's device and the way this node holds, kept by the master's ids (`mirror`), the home and its nodes as the master has them, what is owed to it (`SendQueue`), and what it last said (`LastHeard`) |
| Ids | `randomHex` — from the random values every place has |

Its tests run on bun:sqlite and on SQLite's WebAssembly build
(`test/drivers.ts`).
