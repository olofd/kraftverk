# @kraftverk/transport-https — the internet

## What it is

The internet over HTTPS, for services and cloud devices: each channel
reaches its address and the few origins its protocol declares beside it.

## What it does — and does not

- **Does:** scoped HTTP — a sign-in host as well as the device's, and
  nothing else — with an entry for the server and one for the app.
- **Does not:** know an API: protocols do.

## Where it fits

A transport: the platform layer, importing only the SDK.

## Why a package of its own

Because what a device's code may reach on the internet is decided in one
place, the same everywhere it runs.
