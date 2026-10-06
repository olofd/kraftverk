# @kraftverk/integration-tuya — Tuya's energy sockets

## What it is

Tuya as a platform: its local protocol, its **Zigbee gateway**
(`tuya.gateway`), and energy sockets as smart plugs — a relay and a meter —
reached on the home network with no cloud: on Wi-Fi directly, or behind a
gateway through it. It holds what every Tuya socket shares:
`defineTuyaSocket`, which builds a socket type from a data layout, and the
generic Tuya plug (`tuya.plug`), the one a socket nobody has described falls
back to, either way.

## What it does — and does not

- **Does:** speak Tuya's local protocol, 3.1 to 3.5 (`src/protocol/`):
  framing, the session handshake, the crypto written out — so it runs on a
  phone as well as a server — the discovery broadcast, devices behind a
  Zigbee gateway by their address on it, the refresh that has a Zigbee plug
  measure, and the Smart Life sign-in that fetches a local key once. The
  socket's session — polling, pushes, the relay, settings by profile, live
  readings, its readings dated by when they were measured — and its
  simulator; the generic plug, with one profile per socket layout it knows.
  The gateway as a device of its own and a bridge: one conversation, with
  its key, for every Zigbee device behind it, each handed a `ZigbeeLink`
  (`src/link.ts`) by its Zigbee address; who is behind it, from what it
  reports and what has been linked. How a file kept before the gateway was
  a device comes back with one (`src/migrations.ts`). Tools to scan the
  network and fetch keys (`tools/`, `npm run scan:tuya`, `npm run keys:tuya`).
- **Does not:** know a product's layout — each product is a device package
  built on this — or open a socket: the LAN transport does.

## Where it fits

An integration (docs/PLAN-INTEGRATIONS.md §1.1): it imports the SDK only;
device packages for Tuya-based products import it —
`@kraftverk/device-atorch-s1w` and `@kraftverk/device-tuya-zigbee-plug`
among them — and what they need of the wire from
`@kraftverk/integration-tuya/protocol`.

## Why a package of its own

Because every Tuya socket speaks the same protocol and is the same device
apart from its data layout: written and tested once here, on frames alone,
the next plug is a profile in a package of its own.
