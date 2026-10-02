# @kraftverk/api-client — the API, from the app's side

## What it is

A kraftverk home over HTTP: `httpApi({ baseUrl })` is `KraftverkApi` — the
one interface the hub answers in the process — through a server's routes
and its live socket. Beside it, `serverApi({ baseUrl })`: what is a
server's own and not a home's (`ServerApi`) — whether one answers at an
address, signing in, accounts, its version, its log, its reset, the copy
of its configuration kept beside its database. And the generic screens'
slots.

## What it does — and does not

- **Does:** every call of `KraftverkApi` and `ServerApi` as the route it
  is, with the session cookie and the header that marks a request as the
  app's, on `fetch` — a browser's, a phone's, Bun's, a test's — at the
  address it is handed (`@kraftverk/api-client/http`); a refusal back as
  the `ApiError` the hub threw, and a server out of reach as one too
  (`unavailable`); the live stream, said what the screen shows, opened
  again with a growing wait, and whether it is up. For a screen, over any
  home: a failure in words (`describeError`), and a refusal that only wants
  a person's yes as an answer to ask with (`askingYes`,
  `changeAutomation`, `applyPlan`).
- **Does not:** decide anything, or find a server: it carries what the
  home says, where it is told the home is. Where a server would be, beside
  the app, is the app's platform's to work out (`client/src/platform/`).
  No React Native, no Expo, no HTTP library: `fetch` is everywhere
  kraftverk runs.

## Where it fits

An edge (docs/PLAN-SHARED-CORE.md): the app uses it, and a device
package's own screens (`ui/`) may — never its `src/`, which the server
loads. It speaks in `@kraftverk/api-contract`'s shapes. An app holding
ways for a server wraps the `httpApi` it is handed (`createHolding` in
`@kraftverk/hub`); this does not know.

## Why a package of its own

Because a device's screens live in the device's package, and must call the
server without importing the app that renders them.
