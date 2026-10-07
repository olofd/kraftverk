# @kraftverk/transport-lan — the home network

## What it is

The home network: TCP connections to devices, kept up, and the UDP
broadcasts devices announce themselves with.

## What it does — and does not

- **Does:** keep a connection to a device up, reconnecting with a backoff;
  hear the broadcasts on the UDP ports ways say they are found by, all the
  time — listening sends nothing — each host one sighting with all it said;
  reach private addresses only.
- **Does not:** know a protocol. It runs on the server; a phone's entry
  needs a socket library, a reviewed dependency.

## Where it fits

A transport: the platform layer, importing only the SDK.

## Why a package of its own

Because sockets are platform code, kept out of every protocol and device.
