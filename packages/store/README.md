# @kraftverk/store — a home's data in SQLite

kraftverk's data model (docs/DATA-MODEL.md) as one SQLite schema and the
stores that keep to it. The server keeps a home in a file through
bun:sqlite; the app will keep one on a phone through expo-sqlite, and in a
browser through sql.js — the same schema and the same stores, so a home
reads the same wherever it is kept.

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
