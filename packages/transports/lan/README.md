# @kraftverk/transport-lan — the home network

## What it is

The home network: TCP connections to devices, kept up, and hearing the
devices that announce themselves — UDP broadcasts, mDNS services, SSDP
announcements — on this process's own sockets, or through the relay for a
server in a container.

## What it does — and does not

- **Does:** keep a connection to a device up, reconnecting with a backoff;
  hear what ways say they are found by (`listen.ts`) — the UDP ports
  devices broadcast on, mDNS asked for each service type (`dns.ts`), SSDP
  searched for each target — all the time, each host one sighting with all
  it said, kept as long as it holds (`heard.ts`); reach private addresses
  only. In a container, which multicast does not reach, it hears through
  the relay (`relay.ts`, `relay-main.ts`): the one service on the home
  network, told what to listen for and passing on what it hears, over one
  connection with a token — and nothing else.
- **Does not:** know a protocol; let the relay open anything to a device. It
  runs on the server; a phone's entry needs a socket library, a reviewed
  dependency.

## Where it fits

A transport: the platform layer, importing only the SDK.

## Why a package of its own

Because sockets are platform code, kept out of every protocol and device.
