# For agents working on kraftverk

Read this first; it is short on purpose. The design is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (the authority), the data model in
[docs/DATA-MODEL.md](docs/DATA-MODEL.md), and where things stand in
[docs/HANDOFF.md](docs/HANDOFF.md).

## The phase we are in: research and development — strict version 1

**Nobody runs kraftverk in production but its owner.** Until that changes,
everything is **strict version 1**:

- **No backward compatibility.** No adapters between an old and a new shape, no
  deprecated aliases, no "v3 beside v4". When the model changes, change it
  everywhere at once — packages, holders, gateway, API, app, docs — and delete
  what it replaces.
- **No versioning.** No API versions, no type versions, no migration hooks.
  The one exception, on purpose: the **configuration document**
  (`packages/config`, docs/CONFIG.md) carries `kraftverk: n`, and each
  change to its shape adds a migration from n with a kept fixture. It is
  what carries a home across a database reset, so it must be read by every
  newer kraftverk.
- **One database schema, not a chain of migrations.** When the schema changes,
  the one definition changes. An existing database from an older schema is set
  aside and a new one started; history is not carried over.
- **No nullable fields that exist only because of migrations.** `null` is kept
  where it means something ("the device has not said"), never as "older rows
  lack this".
- **The architecture stays green**: `npm run typecheck`, `npm test` and
  `npm run check:architecture` pass on every commit.

Where the docs say a key or id is "stable forever", read it as the rule from
the first release on. Until then, rename it — and everything that uses it.

**This changes when there is a production state to protect.** Then this
section is replaced by the compatibility rules, and ARCHITECTURE.md §9 says so.

## Rules that never relax

- **Every physical action goes through the gateway.** Never write `0` to the
  P280's holding register 68 — it bricks the station; its whitelist, schema and
  test stay.
- **Nothing about anyone's home in the repository**: no real IPs, host names,
  MACs, device ids, keys or deployment details. Tests use `192.0.2.x` and
  made-up ids.
- **Device-specific code stays in its package**; the core names no product.
- **Others may be editing this checkout.** Stage only the files you changed;
  never `git add -A`.
