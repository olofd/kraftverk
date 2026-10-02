# @kraftverk/home-file — a home, in one file

## What it is

A home as one versioned YAML document — `kraftverk.yaml`: its devices, how
each is reached (secrets included, sealed or left out), the links between
them, its settings and its automations, each written as text a person can
read and edit (docs/CONFIG.md).

## What it does — and does not

- **Does:** read the document with every problem's line and column, and
  write it back the same; its JSON Schema, made from what is installed, so
  an editor completes and checks it as it is typed; check it against the
  installed vocabulary (types, methods, the language); migrate a document
  of an older version (`kraftverk: n`, one migration per change, each with
  a kept fixture); an automation's and a device's own entry, as an export
  writes it (`automationEntryFrom`, `deviceEntryFrom`) — the same functions
  the master's export and the app's YAML of one use.
- **Does not:** touch a database or a device, or seal a secret with a
  passphrase — the place's cipher, asked for by the hub as a port. Planning
  what a document would change, applying it, and keeping a snapshot of a
  home are the hub's (`Configuration`), the snapshot's file the server's; the rule language it writes automations in is
  `@kraftverk/automation`'s.

## Where it fits

With the rules (docs/PLAN-SHARED-CORE.md): above the contract and the
language, which it speaks automations in; the API's shapes and the hub use
it. The server and the app both read and write it.

## Why a package of its own

Because the document is the one thing versioned on purpose (AGENTS.md): it
carries a home across a database reset and between kraftverks, so its
format, its migrations and its fixtures must be one definition that every
newer kraftverk reads — and that a phone can read as well as a server.
