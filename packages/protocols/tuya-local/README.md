# @kraftverk/protocol-tuya-local — the Tuya LAN protocol

## What it is

Tuya's local protocol, 3.1 to 3.5: framing, the session handshake, the
crypto, the discovery broadcast, and the local-key credential.

## What it does — and does not

- **Does:** frames and sessions over a byte channel; the crypto written
  out, so it runs on a phone as well as the server; devices behind a Zigbee
  gateway by their address on it; the refresh that has a Zigbee plug
  measure; the Smart Life sign-in that fetches a local key once.
- **Does not:** know a plug's layout (its device packages), or open a
  socket (the LAN transport).

## Where it fits

A protocol: pure, importing only the SDK; the Tuya socket and its
families build on it.

## Why a package of its own

Because every Tuya device speaks it, and a protocol tested on frames alone
is fixed once for all of them.
