# @kraftverk/api-client — the API, from the app's side

## What it is

The app's client of a kraftverk server: every endpoint as a typed call,
the live stream, and the generic screens' requests.

## What it does — and does not

- **Does:** calls the server's routes with the session cookie and the
  header that marks a request as the app's; opens the live stream, says
  what the screen shows back on it, and reopens it with a growing wait.
- **Does not:** decide anything. It carries what the server says.
  Today it finds the server's address through React Native; that moves to
  the app's platform, so a CLI or a test can use it too, and it implements
  `KraftverkApi` over HTTP (docs/PLAN-SHARED-CORE.md, phase 5).

## Where it fits

An edge (docs/PLAN-SHARED-CORE.md): the app uses it, and a device
package's own screens (`ui/`) may — never its `src/`, which the server
loads. It speaks in `@kraftverk/api-contract`'s shapes.

## Why a package of its own

Because a device's screens live in the device's package, and must call the
server without importing the app that renders them.
