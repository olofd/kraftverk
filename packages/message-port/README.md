# @kraftverk/message-port — kraftverk over a message port

## What it is

A home's `KraftverkApi`, and a `Transport`, carried over a message port:
served on one side, and the very same interface on the other. A browser
keeps a home of its own in a worker, because a lasting SQLite needs one
(docs/PLAN-SHARED-CORE.md, "SQLite in the app"); the screens on the page
ask it through this, and the hub in the worker reaches the transports the
page runs — Web Bluetooth, a chooser that needs a person's tap — through
this, as if each were its own.

## What it does — and does not

- **Does:** `serveApi(api, end)` and `apiOver(end)` — every call by its
  path, its answer back, a refusal as the `ApiError` it was, the live
  stream as a stream, a step's abort as an abort; and a call the interface
  does not have refused on the serving side, so nothing an object has is a
  way in. `serveTransport(end, factory, here)` and
  `transportOver(definition, end)` — starting and stopping it, whether it
  can be used, what it sees and its chooser, and each channel it opens,
  with every byte, broker message and HTTP answer both ways; what it says
  on its timeline and in its log goes to the hub's.
- **Does not:** choose where anything runs, start a worker, take a lock or
  open a database — that is the place's (the app's `platform/`). It names
  no call of the interface and no transport: whatever either gains crosses
  as it is.

## Where it fits

Shared, above the API's shapes and the contract (docs/PLAN-SHARED-CORE.md):
it imports `@kraftverk/api-contract` and `@kraftverk/device-sdk`, and
nothing imports it but the places that put a hub and its screens in two
realms — today a browser's page and its worker. The hub does not know it
exists, and neither does a phone, whose hub runs beside its screens.

## Why a package of its own

Because the two ends of a wire must agree, and agree in one place: the
messages are shaped here and nowhere else. Kept apart from the hub and the
API's client, a hub never learns it is in a worker, and the same carrier
serves the next realm a home may run in — a phone's background runtime, a
shared worker, a desktop shell's process — with no screen changing. The
server's agreement suite asks a home this way too, and gets the answers
the process and HTTP give.

## In detail

An end is anything that posts a message and hears one (`MessageEnd`): a
`MessagePort`, a `Worker`, a worker's own scope. Several conversations
share one end by name (`via`): the home as `api`, each transport as
`transport:<id>`.

- **Answers are structured clones**: plain data, `Uint8Array`,
  `ArrayBuffer`. An HTTP answer crosses as its status, headers and bytes,
  and is a `Response` again on the other side.
- **What is asked without waiting** — whether a transport can be used, its
  values, its diagnostics' names — is said by the side running it, and
  kept on the other: once when it starts, and again whenever it changes.
- **What a transport keeps between runs** is kept where it runs: a
  `TransportStore` is read as it is asked, which cannot wait for an answer
  from across.
