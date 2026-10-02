# @kraftverk/api-client — the API, from the app's side

## What it is

A kraftverk home over HTTP: `httpApi({ baseUrl })` is `KraftverkApi` — the
one interface the hub answers in the process — through a server's routes
and its live socket; and the generic screens' slots.

## What it does — and does not

- **Does:** every call of `KraftverkApi` as the route it is, with the
  session cookie and the header that marks a request as the app's, on
  `fetch` — a browser's, a phone's, Bun's, a test's — at the address it is
  handed (`@kraftverk/api-client/http`, which needs no React Native); a
  refusal back as the `ApiError` the hub threw; the live stream, said what
  the screen shows, opened again with a growing wait, and whether it is up.
  For a screen, over any home: a refusal that only wants a person's yes as
  an answer to ask with (`askingYes`, `changeAutomation`, `applyPlan`).
- **Does not:** decide anything, or find the server: it carries what the
  home says, where it is told the home is. The older calls beside it
  (`api.ts`), which find the address through React Native, go when the app
  asks `KraftverkApi` alone (docs/PLAN-SHARED-CORE.md, phase 6).

## Where it fits

An edge (docs/PLAN-SHARED-CORE.md): the app uses it, and a device
package's own screens (`ui/`) may — never its `src/`, which the server
loads. It speaks in `@kraftverk/api-contract`'s shapes.

## Why a package of its own

Because a device's screens live in the device's package, and must call the
server without importing the app that renders them.
