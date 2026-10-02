# @kraftverk/transport-mqtt — kraftverk's own broker

## What it is

MQTT through kraftverk's own broker — the one devices connect to instead
of their vendor's cloud — and the server's privileged connection to it.

## What it does — and does not

- **Does:** run the broker as its own process, so the server can restart
  without dropping a station; apply, on every publish, the guard of the
  protocol a device speaks.
- **Does not:** know a protocol: each installed protocol supplies its topics
  and the commands the broker must refuse.

## Where it fits

A transport: the platform layer, importing only the SDK; server only.

## Why a package of its own

Because a broker is a server's to run, and a protocol's guard must stand
at it whichever client publishes.
