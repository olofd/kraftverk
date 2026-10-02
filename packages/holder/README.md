# @kraftverk/holder — holding a device's connection

## What it is

What every holder of a device's connection does, written once: the server
and an app that holds connections of its own run the same code.

## What it does — and does not

- **Does:** opens a device over its connection — its transport's channel,
  the protocol's guard on it, the type's session or its simulator — within
  a timeout; builds the device's context and schedules its work; judges
  what a setup's check found; refuses a connection that reaches a different
  device; fails over from one down too long. `SessionManager` keeps one
  session for every device its holder holds: which connections are its own
  is the holder's to say (`holds`), and it retries what can mend itself and
  publishes what devices say on the `LiveBus`.
- **Does not:** keep anything (the store's, through small ports), decide
  what a home has (it is told), know any product or transport, or send a
  command (the gateway's).

## Where it fits

The runtime layer (docs/PLAN-SHARED-CORE.md): above the contract, the
language, the gateway and the API's shapes; under the engine, the store and
the hub. A hub builds a `SessionManager` with `holding(connections,
self.id)` from the store — the ways its node holds — and a follower with
the ways it holds for the master.

## Why a package of its own

Because a device is held in two places — on the server, and in an app that
reaches it over its own Bluetooth — and two copies of opening, failover
and the wrong-device check drift apart (they did, until phase 4). One
package is one behaviour, tested once.
